"""
reconcile-feeds-ifc.py

The automated half of the dual-source plant->zone (feeds) cross-check.

Room schematics carry the feeding plant, which is read by eye during extraction
and written to building-connections.json. This script derives the SAME
relationship independently from the installation IFC model:

    IfcSystem -> member elements -> containing IfcSpace (room) -> room id
    -> spatial-hierarchy zones -> plant (profile naming.ifcSystemPlant) -> {zones}

(the room id has its '-N' split suffix stripped before the zone lookup).

rooms_by_system() and plant_for_system() are also used by build-spatial-hierarchy.py
(roomPlants in ifc-spatial.json).

then diffs the IFC-derived feeds against the image-derived feeds in
building-connections.json and reports, per plant: agreement / IFC-only / image-only.
Disagreements are flagged for review rather than silently trusted to either source.

The system -> plant alias is the profile's naming.ifcSystemPlant rule ({pattern, plant,
flags?}; '$n' in plant is group n of the pattern, matched from the start of the system
name). Systems the rule does not match are reported as unmapped, not guessed.

Data roots: the profile is read from BUILDING_DATA_ROOT (else <repo>/data), but
spatial-hierarchy.json and building-connections.json are always read from <repo>/data.
With BUILDING_DATA_ROOT set elsewhere the two sources are mixed.

Usage:
    python tools/reconcile-feeds-ifc.py <buildingId> <installation_ifc_path> [--emit-json out.json]
"""

import argparse
import json
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

import ifcopenshell


SPLIT_SUFFIX = re.compile(r"-\d+$")        # "0.01-3" -> "0.01"
REPO = Path(__file__).resolve().parent.parent


def norm_room(name: str) -> str:
    """Normalize an IFC space name to the spatial-hierarchy room id form."""
    if not name:
        return ""
    return SPLIT_SUFFIX.sub("", name.strip())


def rooms_by_system(model) -> dict:
    """system name -> set(normalized room ids) via member elements' containing IfcSpace."""
    out = defaultdict(set)
    for sysm in model.by_type("IfcSystem"):
        sname = sysm.Name or ""
        for rel in (sysm.IsGroupedBy or []):
            for el in rel.RelatedObjects:
                for r in (getattr(el, "ContainedInStructure", None) or []):
                    st = r.RelatingStructure
                    if st.is_a("IfcSpace") and st.Name:
                        out[sname].add(norm_room(st.Name))
    return out


def load_profile(building_id: str) -> dict:
    root = Path(os.environ.get("BUILDING_DATA_ROOT") or (REPO / "data"))
    path = root / building_id / "building-config.json"
    if not path.exists():
        print(f"Error: profile not found: {path}", file=sys.stderr)
        sys.exit(1)
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except ValueError as e:
        print(f"Error: profile {path} is not valid JSON: {e}", file=sys.stderr)
        sys.exit(1)


def ifc_system_rule(profile: dict) -> dict | None:
    """The profile's naming.ifcSystemPlant rule, or None when it has none."""
    return ((profile or {}).get("naming") or {}).get("ifcSystemPlant")


def plant_for_system(name: str, rule: dict | None) -> str | None:
    """IFC system name -> plant id by the profile rule; None when there is no rule or it does not match."""
    if not rule:
        return None
    flags = 0
    for ch in rule.get("flags") or "":
        flags |= {"i": re.I, "m": re.M, "s": re.S}.get(ch, 0)
    m = re.match(rule["pattern"], name or "", flags)
    if not m:
        return None
    return re.sub(r"\$(\d+)", lambda g: m.group(int(g.group(1))), rule["plant"])


def main():
    ap = argparse.ArgumentParser(description="Reconcile installation-IFC plant->zone feeds vs building-connections.json")
    ap.add_argument("buildingId")
    ap.add_argument("vent_ifc", metavar="installation_ifc")
    ap.add_argument("--emit-json", default=None, help="write the IFC-derived {plant: [zones]} to this path")
    args = ap.parse_args()

    rule = ifc_system_rule(load_profile(args.buildingId))
    if rule is None:
        print(f"profile of {args.buildingId} has no naming.ifcSystemPlant", file=sys.stderr)
        sys.exit(1)

    root = REPO
    spatial_path = root / "data" / args.buildingId / "inputs" / "spatial-hierarchy.json"
    conn_path = root / "data" / args.buildingId / "inputs" / "building-connections.json"
    for p in (Path(args.vent_ifc), spatial_path):
        if not p.exists():
            print(f"Error: not found: {p}", file=sys.stderr)
            sys.exit(1)

    spatial = json.loads(spatial_path.read_text(encoding="utf-8"))
    # room id -> zone ids, derived from the zone-centred zones[].roomIds
    room_to_zones = {}
    for z in spatial.get("zones", []):
        for rid in z.get("roomIds", []):
            room_to_zones.setdefault(rid, set()).add(z["id"])

    print(f"opening {args.vent_ifc} ...")
    model = ifcopenshell.open(args.vent_ifc)
    sys_rooms = rooms_by_system(model)

    # Aggregate systems into plants (profile rule) -> rooms -> zones
    plant_rooms = defaultdict(set)
    unmapped_systems = []
    rooms_not_in_spatial = set()
    for sname, rooms in sys_rooms.items():
        plant = plant_for_system(sname, rule)
        if plant is None:
            unmapped_systems.append(sname)
            continue
        plant_rooms[plant].update(rooms)

    plant_zones = {}
    for plant, rooms in plant_rooms.items():
        zones = set()
        for rm in rooms:
            if rm in room_to_zones:
                zones.update(room_to_zones[rm])
            else:
                rooms_not_in_spatial.add(rm)
        plant_zones[plant] = zones

    # Image-derived feeds (may not exist yet)
    image_feeds = {}
    if conn_path.exists():
        conn = json.loads(conn_path.read_text(encoding="utf-8"))
        for f in conn.get("plantFeedsZone", []):
            image_feeds[f["plantId"]] = set(f.get("zoneIds", []))

    # Report
    print(f"\nInstallation IFC feeds reconciliation for {args.buildingId}")
    print(f"  systems: {len(sys_rooms)} | mapped to a plant: {len(plant_zones)} | unmapped: {len(unmapped_systems)}")
    print(f"  building-connections.json: {'present' if conn_path.exists() else 'ABSENT (IFC-only listing)'}")
    print()
    for plant in sorted(plant_zones):
        ifc_z = plant_zones[plant]
        img_z = image_feeds.get(plant, set())
        if conn_path.exists():
            match = ifc_z & img_z
            ifc_only = ifc_z - img_z
            img_only = img_z - ifc_z
            print(f"  {plant}: IFC={len(ifc_z)} image={len(img_z)} match={len(match)}"
                  + (f" | IFC-only={sorted(ifc_only)}" if ifc_only else "")
                  + (f" | image-only={sorted(img_only)}" if img_only else ""))
        else:
            print(f"  {plant}: IFC zones={len(ifc_z)} -> {sorted(ifc_z)}")

    if unmapped_systems:
        print(f"\n  unmapped IFC systems (no plant alias — review): {sorted(unmapped_systems)}")
    if rooms_not_in_spatial:
        print(f"  IFC rooms not in spatial-hierarchy ({len(rooms_not_in_spatial)}): {sorted(rooms_not_in_spatial)}")

    if args.emit_json:
        Path(args.emit_json).write_text(
            json.dumps({p: sorted(z) for p, z in plant_zones.items()}, indent=2, ensure_ascii=False),
            encoding="utf-8")
        print(f"\n  IFC-derived feeds written to {args.emit_json}")


if __name__ == "__main__":
    main()
