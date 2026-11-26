/**
 * run-equipment-extraction.ts
 *
 * Headless batch runner: for each room or plant image it starts `claude -p`
 * with a short prompt that points the agent at the skills and at the
 * building's own screen guide and notes (profile fields bmsScreens, notes).
 * The method lives in those files, not here.
 *
 * Limit: no human is present in a batch run, so the human-in-the-loop
 * touchpoint 1 confirmation (ductPath, ductOrientation) and the medium
 * confirmation are not done. The plant prompt therefore does not write them,
 * and skips a plant that already has a ductOrientation.
 *
 * Results are written to equipment-inventory.json via update-equipment.ts
 * (upsert semantics). The runner refuses to start unless the profile has
 * bmsScreens and the stage's image folders (inputs.images.rooms / .plants).
 *
 * Limit: the image queue and the inventory check read dataRoot() (BUILDING_DATA_ROOT
 * when set), but the paths in the prompts (screen guide, notes, image, inventory)
 * are always data/<buildingId>/... under the repo, where the agent runs. With
 * BUILDING_DATA_ROOT pointing elsewhere the agent is sent to the repo copy.
 *
 * Usage:
 *   npx ts-node tools/run-equipment-extraction.ts <buildingId> --stage rooms|plants|all
 *   npx ts-node tools/run-equipment-extraction.ts <buildingId> --stage rooms --start-from 30
 *   npx ts-node tools/run-equipment-extraction.ts <buildingId> --stage rooms --dry-run
 *
 * Options:
 *   --stage rooms|plants|all   Which images to process (default: all)
 *   --start-from N             Skip the first N images (for resuming)
 *   --force                    Re-process all images even if already in inventory
 *   --dry-run                  Show what would be processed without running
 *   --delay N                  Seconds between invocations (default: 2)
 *   --limit N                  Process at most N images
 *   --timeout-sec N            Per-image subprocess timeout (default: 180)
 */

import { readdirSync, readFileSync, existsSync, writeFileSync } from 'fs'
import { resolve, basename } from 'path'
import { execSync } from 'child_process'
import { loadProfile, dataRoot, BuildingProfile } from './lib/building-profile'

// ─── Helpers ────────────────────────────────────────────────────────────────

function getArg(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name)
  return idx !== -1 ? args[idx + 1] : undefined
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name)
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function getAlreadyProcessedImages(invPath: string): Set<string> {
  const processed = new Set<string>()
  if (!existsSync(invPath)) return processed

  const inv = JSON.parse(readFileSync(invPath, 'utf-8'))
  for (const z of inv.zoneEquipment || []) {
    if (z.sourceImage) processed.add(z.sourceImage)
  }
  for (const p of inv.plantEquipment || []) {
    if (p.sourceImage) processed.add(p.sourceImage)
  }
  return processed
}

function listImages(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.jpeg'))
    .sort()
}

// ─── Prompt builders ────────────────────────────────────────────────────────

/** A message when the runner cannot start for this profile and stage, else null. */
export function runnerProblem(profile: BuildingProfile, stage: 'rooms' | 'plants' | 'all'): string | null {
  const missing: string[] = []
  if (!profile.bmsScreens) missing.push("bmsScreens (the screen guide of the building)")
  const images = profile.inputs.images ?? {}
  if ((stage === 'rooms' || stage === 'all') && !images.rooms) missing.push('inputs.images.rooms')
  if ((stage === 'plants' || stage === 'all') && !images.plants) missing.push('inputs.images.plants')
  if (missing.length === 0) return null
  return `building-config.json of ${profile.buildingId} lacks: ${missing.join(', ')}. Declare them in the profile before running the extraction.`
}

function guideLines(buildingId: string, profile: BuildingProfile): string {
  const files = [profile.bmsScreens, ...(profile.notes ?? [])]
    .filter((f): f is string => !!f)
    .map(f => `data/${buildingId}/${f}`)
  return files.map(f => `   - ${f}`).join('\n')
}

export function buildRoomPrompt(buildingId: string, relativePath: string, imagePath: string, profile: BuildingProfile): string {
  return `You are extracting zone equipment from a BMS room schematic image for building ${buildingId}.
This is a headless batch run: no human is present, so do not ask questions.

1. Read .claude/skills/skill-00-context.md (Image Processing Rules, BMS Image Reading Protocol and Danish Language Awareness)
   and .claude/skills/equipment-inventory/SKILL.md (Stage 2, room schematics).
2. Read the building's own screen guide and notes, and follow them where they are specific to this building:
${guideLines(buildingId, profile)}
3. Process this room image: ${imagePath}
   Read every label from an upscaled crop, never from the full frame. Only include equipment whose label you read.
   Do not include the parent plant reference box as zone equipment; the building's plant list says which ids are plants.
4. Write exactly one entry with sourceImage "${relativePath}" using:
   echo '<json>' | npx ts-node tools/update-equipment.ts ${buildingId} --type zone
   After writing, you are done.`
}

export function buildPlantPrompt(buildingId: string, relativePath: string, imagePath: string, profile: BuildingProfile): string {
  return `You are extracting plant equipment from a BMS plant schematic image for building ${buildingId}.
This is a headless batch run: no human is present, so do not ask questions.

1. Read .claude/skills/skill-00-context.md (Image Processing Rules, BMS Image Reading Protocol and Danish Language Awareness)
   and .claude/skills/equipment-inventory/SKILL.md (Stage 1, plant schematics).
2. Read the building's own screen guide and notes, and follow them where they are specific to this building:
${guideLines(buildingId, profile)}
3. If this plant's entry in data/${buildingId}/inputs/equipment-inventory.json already has a ductOrientation, skip this plant.
4. Process this plant image: ${imagePath}
   Read every label from an upscaled crop, never from the full frame. Only include equipment whose label you read.
5. Do not write ductPath, ductOrientation or medium: they need touchpoint 1 and the medium confirmation with a human.
6. Write exactly one entry with sourceImage "${relativePath}" using:
   echo '<json>' | npx ts-node tools/update-equipment.ts ${buildingId} --type plant
   After writing, you are done.`
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2)
  const buildingId = args[0]

  if (!buildingId) {
    console.error('Usage: npx ts-node tools/run-equipment-extraction.ts <buildingId> --stage rooms|plants|all')
    process.exit(1)
  }

  const stageArg = getArg(args, '--stage') || 'all'
  if (stageArg !== 'rooms' && stageArg !== 'plants' && stageArg !== 'all') {
    console.error('--stage must be rooms, plants or all')
    process.exit(1)
  }
  const stage: 'rooms' | 'plants' | 'all' = stageArg
  const startFrom = parseInt(getArg(args, '--start-from') || '0', 10)
  const dryRun = hasFlag(args, '--dry-run')
  const force = hasFlag(args, '--force')
  const delay = parseInt(getArg(args, '--delay') || '2', 10) * 1000
  const limit = parseInt(getArg(args, '--limit') || '0', 10)  // 0 = no limit; >0 caps images processed (for testing)
  const timeoutMs = parseInt(getArg(args, '--timeout-sec') || '180', 10) * 1000  // per-image subprocess timeout

  const profile = loadProfile(buildingId)
  const problem = runnerProblem(profile, stage)
  if (problem) {
    console.error(problem)
    process.exit(1)
  }

  const dataDir = resolve(dataRoot(), buildingId)
  const invPath = resolve(dataDir, 'inputs', 'equipment-inventory.json')
  const logPath = resolve(dataDir, 'equipment-extraction-log.json')

  // Check what's already processed
  const alreadyProcessed = getAlreadyProcessedImages(invPath)
  console.log(`Already processed: ${alreadyProcessed.size} images`)

  // Build image queue
  interface ImageTask {
    type: 'room' | 'plant'
    file: string
    relativePath: string
    fullPath: string
  }

  const queue: ImageTask[] = []

  if (stage === 'rooms' || stage === 'all') {
    const roomFolder = profile.inputs.images!.rooms!
    const roomImages = listImages(resolve(dataDir, roomFolder))
    for (const file of roomImages) {
      queue.push({
        type: 'room',
        file,
        relativePath: `${basename(roomFolder)}/${file}`,
        fullPath: `data/${buildingId}/${roomFolder}/${file}`,
      })
    }
  }

  if (stage === 'plants' || stage === 'all') {
    const plantFolder = profile.inputs.images!.plants!
    const plantImages = listImages(resolve(dataDir, plantFolder))
    for (const file of plantImages) {
      queue.push({
        type: 'plant',
        file,
        relativePath: `${basename(plantFolder)}/${file}`,
        fullPath: `data/${buildingId}/${plantFolder}/${file}`,
      })
    }
  }

  // Filter out already processed (unless --force) and apply start-from
  const toProcessAll = force
    ? queue.slice(startFrom)
    : queue.filter(t => !alreadyProcessed.has(t.relativePath)).slice(startFrom)
  const toProcess = limit > 0 ? toProcessAll.slice(0, limit) : toProcessAll

  const skippedAlready = force ? 0 : queue.filter(t => alreadyProcessed.has(t.relativePath)).length
  console.log(`\nImage queue:`)
  console.log(`  Total images: ${queue.length}`)
  console.log(`  Already processed: ${skippedAlready}`)
  console.log(`  Skipped (--start-from): ${startFrom}`)
  console.log(`  To process: ${toProcess.length}`)
  console.log()

  if (dryRun) {
    console.log('--dry-run: images that would be processed:')
    for (let i = 0; i < toProcess.length; i++) {
      const t = toProcess[i]
      console.log(`  ${i + 1}. [${t.type}] ${t.fullPath}`)
    }
    return
  }

  if (toProcess.length === 0) {
    console.log('Nothing to process — all images already in equipment-inventory.json')
    return
  }

  // Process sequentially
  const log: Array<{
    index: number
    image: string
    type: string
    status: 'success' | 'error'
    duration_ms: number
    error?: string
    timestamp: string
  }> = []

  for (let i = 0; i < toProcess.length; i++) {
    const task = toProcess[i]
    const progress = `[${i + 1}/${toProcess.length}]`

    console.log(`${progress} Processing ${task.type}: ${task.fullPath}`)
    const startTime = Date.now()

    const prompt = task.type === 'room'
      ? buildRoomPrompt(buildingId, task.relativePath, task.fullPath, profile)
      : buildPlantPrompt(buildingId, task.relativePath, task.fullPath, profile)

    try {
      // Use claude -p with allowed tools for file reading and bash execution
      const result = execSync(
        `claude -p "${prompt.replace(/"/g, '\\"')}" --allowedTools "Read,Bash,Glob,Grep"`,
        {
          cwd: resolve(__dirname, '..'),
          timeout: timeoutMs, // per-image timeout (--timeout-sec, default 180)
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      )

      const duration = Date.now() - startTime

      // Verify the write actually landed — a clean exit does NOT mean the
      // subprocess wrote anything. Treat "exited but no entry" as a failure,
      // not a silent success.
      const wrote = getAlreadyProcessedImages(invPath).has(task.relativePath)
      console.log(`${progress} ${wrote ? 'Done' : 'EXITED WITHOUT WRITING'} in ${(duration / 1000).toFixed(1)}s`)
      if (!wrote || hasFlag(args, '--verbose')) {
        console.log(`--- subprocess output (${task.relativePath}) ---\n${result.trim().slice(-1500)}\n--- end ---`)
      }

      log.push({
        index: i,
        image: task.fullPath,
        type: task.type,
        status: wrote ? 'success' : 'error',
        duration_ms: duration,
        error: wrote ? undefined : 'subprocess exited without writing an inventory entry',
        timestamp: new Date().toISOString(),
      })
    } catch (err: any) {
      const duration = Date.now() - startTime
      const errorMsg = err.message?.slice(0, 200) || 'unknown error'
      console.error(`${progress} FAILED (${(duration / 1000).toFixed(1)}s): ${errorMsg}`)

      log.push({
        index: i,
        image: task.fullPath,
        type: task.type,
        status: 'error',
        duration_ms: duration,
        error: errorMsg,
        timestamp: new Date().toISOString(),
      })
    }

    // Save log after each image
    writeFileSync(logPath, JSON.stringify(log, null, 2), 'utf-8')

    // Delay between invocations to avoid rate limits
    if (i < toProcess.length - 1) {
      await sleep(delay)
    }
  }

  // Final summary
  const successes = log.filter(l => l.status === 'success').length
  const failures = log.filter(l => l.status === 'error').length
  const totalTime = log.reduce((sum, l) => sum + l.duration_ms, 0)

  console.log(`\n${'='.repeat(50)}`)
  console.log(`Extraction complete:`)
  console.log(`  Succeeded: ${successes}`)
  console.log(`  Failed:    ${failures}`)
  console.log(`  Total time: ${(totalTime / 1000 / 60).toFixed(1)} minutes`)
  console.log(`  Log saved: ${logPath}`)

  if (failures > 0) {
    console.log(`\nFailed images:`)
    for (const l of log.filter(l => l.status === 'error')) {
      console.log(`  - ${l.image}: ${l.error}`)
    }
    console.log(`\nRe-run with same command to retry failed images (upsert semantics).`)
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error('Runner failed:', err.message)
    process.exit(1)
  })
}
