# AI-Cx Building Data Agent

## Project Overview

You are an AI agent for the AI-Cx project — mapping proprietary BMS/CTS building data to the Brick (nightly) ontology. The output is a single validated `.ttl` file per building to query directly with SPARQL, or import into a database such as GraphDB for scalable storage and reasoning.

**Working directory:** the repository root.  
All file paths are relative to this root. Verify this is your cwd before reading or writing any files.

---

## How to Start Each Session

### Step 1 — Read the skill file for the current task
```
Read: .claude/skills/skill-00-context.md       ← shared context (always load first)
Read: .claude/skills/{skill-name}/SKILL.md    ← only the relevant skill
```
Do not load all skill files at once. Each skill's SKILL.md contains its own instructions, tool usage, and examples.

---

## One-Time Setup (if not done)

```bash
# Generate Brick ontology indexes (only re-run if Brick_nightly.ttl is updated -- the
# indexes are built from ontologies/Brick_nightly.ttl, added on 2026-08-17)
npx ts-node tools/build-brick-classification-index.ts ontologies/Brick_nightly.ttl ontologies/brick-classification-index.json
npx ts-node tools/build-brick-relationship-index.ts ontologies/Brick_nightly.ttl ontologies/brick-relationship-index.json
```

---

## Rules That Always Apply

1. **Read the skill file before doing anything else** — do not explore data, write scripts,
   or take any action until `skill-00-context.md` and the relevant skill's SKILL.md have been
   read in full. If you find yourself writing an inline script to explore the model, stop —
   you have not read the skill file yet.
2. **Save after every image** during image extraction — never batch image saves
3. **Never load `Brick_nightly.ttl` directly** — always use `ontologies/brick-classification-index.json`
4. **Never use inline shell scripts or shell constructs** — `node -e`, `python3 -c`,
   `comm`, process substitution `<()`, `for` loops, `while` loops, `if` blocks,
   or any multi-line bash — these fail on Windows/Git Bash. Always use individual
   `npx ts-node` tool calls, chained with `&&` if batching is needed.
5. **Brick classes are written into source data files** — classify-all.ts writes `brickClass`
   directly into plant-point-mapping.json, zone-point-mapping.json, equipment-inventory.json,
   and spatial-hierarchy.json. generate-ttl.ts reads from these files. The source data files
   are the single source of truth for both structure and classification.

   **Classification is assembled from PARTS on ONE flat pipeline.** For
   every route, `classify-all` collects each point's contributions from the building's one-shape
   `point-dictionary.json` (`tools/lib/point-parts.ts`: override, image `ductPath`, id suffix,
   description words, id token, unit/state texts, plant class), decides each part (role, quantity,
   medium, water kind, stream, subject, intent, occupancy) by the first source in that order, pools
   the other tags, applies the generic conventions (`tools/lib/tag-match.ts` `combineParts`), and
   `matchPointClass` picks the Brick class from Brick's own class tags. Plants are classified the
   same way (`tools/lib/plant-class.ts`: plant override, plant-token entry + `plantName` words +
   parent plant, image equipment composition as check). Disagreements are written as `classFlags`
   on the point (a trade-off alone does not set `needsReview`). Every point's tags reach the TTL via
   `brick:hasTag`; a `reviewedManually` point keeps its class and gets its tags too, minus each tag
   that contradicts a decided part (role incl. On/Off, quantity, medium, water kind, stream, subject,
   intent, occupancy) its reviewed class settles, or that is the opposite of the class's water
   frame (Entering/Leaving, Supply/Return). Every word, token, suffix and unit symbol the
   point and plant classification uses is a cited dictionary entry, and equipment description words
   are word entries with `appliesTo: ["equipment"]`; there is no `category`. **Known exception:** when no
   screenshot gives a plant point its supply or return side, `classify-all.ts` (`resolveRawDirection`)
   searches its description and `semanticMeaning` for fixed words (`fremløb`, `frem`, `supply`,
   `returløb`, `retur`, `return`). These words are in the code, not the dictionary. Every point
   decided this way gets `needsReview`. The BACnet route has no building or vendor names in code:
   object grouping comes from the profile's `naming.objectNames`, vendor registers are dictionary
   entries, and equipment items come from the dictionary's `equipmentType`.
   **Points are FLAT — no subpoints** (canonical Brick; the TTL always emitted subpoints as flat sibling Points). BACnet points are natively flat; timeseries CSV
   sub-rows are flattened by the mappers to self-contained points whose `idParts` carry the base
   token and the suffix. Verify with `tools/diff-pointclass.ts <a> <b>` (by-id class diff),
   `tools/compare-classes-by-cause.ts` (class changes grouped by cause) + the standard validators.

6. Ask, don't assume. If something is unclear, ask before writing a single line. Never make silent assumptions about intent, architecture, or requirements.

7. Simplest solution first. Always implement the simplest thing that could work. Do not add abstractions or flexibility that weren't explicitly requested.

8. Don't touch unrelated code. If a file or function is not directly part of the current task, do not modify it, even if you think it could be improved.

9. Flag uncertainty explicitly. If you are not confident about an approach or technical detail, say so before proceeding. Confidence without certainty causes more damage than admitting a gap.

---

## Current Buildings

Buildings are the folders under `data/` that have a `building-config.json`. `npx ts-node tools/pipeline-status.ts {buildingId}` shows which steps apply and which are done.

---

## Skills

Each skill has its own SKILL.md with full instructions, tool usage, and examples —
`point-mapping`, `building-connections`, `equipment-inventory`, `brick-assign`,
`brick-relationships`, `generate-ttl` — plus the shared `skill-00-context.md`, which
also has the full pipeline tool reference (reads/writes/usage per tool, timeseries vs BACnet
differences, data-flow diagram).

---

```
Show me the current progress for {buildingId}
Classify all entities for {buildingId}
Generate TTL for {buildingId}
```
