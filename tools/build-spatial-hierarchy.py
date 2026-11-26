"""
build-spatial-hierarchy.py

IFC extraction only (step 1): writes data/<id>/inputs/ifc-spatial.json with the facts the IFC files hold.

  - building: name, longName, guid (architecture IFC)
  - storeys: every IfcBuildingStorey (guid, name, elevation_mm)
  - spaces: every IfcSpace (number = Name, name = LongName, storeyGuid, category = the property "Category")
  - roomPlants (only when the profile lists installation IFCs): room number -> plants whose system's member
    elements sit in that room, using reconcile-feeds-ifc.py's system walk (rooms_by_system) and its
    system -> plant alias (plant_for_system, from the profile's naming.ifcSystemPlant)

No filtering, no level numbering, no zones: tools/match-zone-rooms.ts does exclusions (dictionary words),
storey numbering, the zone-room rule and the checks, and writes spatial-hierarchy.json.

Usage:
    python tools/build-spatial-hierarchy.py --building <id> [--raw-root <dir>]

The profile is data/<id>/building-config.json (data root: BUILDING_DATA_ROOT, else <repo>/data). The IFC paths
in it (inputs.architectureIfc, inputs.installationIfcs) are relative to <raw-root>/<id>/ (default raw root
<repo>/data). The output is always <repo>/data/<id>/inputs/ifc-spatial.json.
"""

import argparse
import importlib.util
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

import ifcopenshell

REPO = Path(__file__).resolve().parent.parent


def fail(msg: str):
    print(f"Error: {msg}", file=sys.stderr)
    sys.exit(1)


def load_reconcile():
    """reconcile-feeds-ifc.py as a module (its file name is not importable by name)."""
    path = Path(__file__).resolve().parent / "reconcile-feeds-ifc.py"
    spec = importlib.util.spec_from_file_location("reconcile_feeds_ifc", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def load_profile(building_id: str) -> dict:
    root = Path(os.environ.get("BUILDING_DATA_ROOT") or (REPO / "data"))
    path = root / building_id / "building-config.json"
    if not path.exists():
        fail(f"profile not found: {path}")
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except ValueError as e:
        fail(f"profile {path} is not valid JSON: {e}")


def _pset_properties(element) -> dict:
    props = {}
    for definition in element.IsDefinedBy:
        if definition.is_a("IfcRelDefinesByProperties"):
            prop_set = definition.RelatingPropertyDefinition
            if prop_set.is_a("IfcPropertySet"):
                for prop in prop_set.HasProperties:
                    if hasattr(prop, "NominalValue") and prop.NominalValue:
                        props[prop.Name] = prop.NominalValue.wrappedValue
    return props


def _storey_guid(space) -> str | None:
    for rel in getattr(space, "Decomposes", None) or []:
        if rel.is_a("IfcRelAggregates") and rel.RelatingObject.is_a("IfcBuildingStorey"):
            return rel.RelatingObject.GlobalId
    for rel in getattr(space, "ContainedInStructure", None) or []:
        if rel.RelatingStructure.is_a("IfcBuildingStorey"):
            return rel.RelatingStructure.GlobalId
    return None


def extract_architecture(ifc_path: Path) -> dict:
    print(f"Opening architecture IFC: {ifc_path}")
    model = ifcopenshell.open(str(ifc_path))

    project_name = None
    for project in model.by_type("IfcProject"):
        project_name = project.LongName or project.Name
    building = {"name": "", "longName": "", "guid": ""}
    for bldg in model.by_type("IfcBuilding"):
        building = {
            "name": bldg.Name or bldg.LongName or project_name or "",
            "longName": bldg.LongName or "",
            "guid": bldg.GlobalId,
        }

    storeys = [
        {"guid": s.GlobalId, "name": s.Name, "elevation_mm": s.Elevation}
        for s in model.by_type("IfcBuildingStorey")
    ]
    storeys.sort(key=lambda s: (s["elevation_mm"] is None, s["elevation_mm"] or 0))

    spaces = [
        {
            "number": sp.Name,
            "name": sp.LongName,
            "storeyGuid": _storey_guid(sp),
            "category": _pset_properties(sp).get("Category", ""),
        }
        for sp in model.by_type("IfcSpace")
    ]
    spaces.sort(key=lambda s: s["number"] or "")
    return {"building": building, "storeys": storeys, "spaces": spaces}


def extract_room_plants(ifc_paths: list[Path], rule: dict | None) -> dict:
    """room number -> sorted plants, over every installation IFC (system walk + the profile's alias rule)."""
    reconcile = load_reconcile()
    room_plants = defaultdict(set)
    unmapped = set()
    for p in ifc_paths:
        print(f"Opening installation IFC: {p}")
        model = ifcopenshell.open(str(p))
        for system, rooms in reconcile.rooms_by_system(model).items():
            plant = reconcile.plant_for_system(system, rule)
            if plant is None:
                unmapped.add(system)
                continue
            for room in rooms:
                room_plants[room].add(plant)
    if unmapped:
        print(f"  systems with no plant alias (not used): {sorted(unmapped)}")
    return {room: sorted(plants) for room, plants in sorted(room_plants.items())}


def main():
    parser = argparse.ArgumentParser(description="Extract IFC facts to data/<id>/inputs/ifc-spatial.json")
    parser.add_argument("--building", required=True, help="building id (data/<id>/building-config.json)")
    parser.add_argument("--raw-root", default=str(REPO / "data"),
                        help="folder holding <id>/<IFC paths from the profile> (default <repo>/data)")
    args = parser.parse_args()

    profile = load_profile(args.building)
    inputs = profile.get("inputs") or {}
    arch_rel = inputs.get("architectureIfc")
    if not isinstance(arch_rel, str) or not arch_rel:
        fail(f"profile of {args.building} has no inputs.architectureIfc")
    install_rels = inputs.get("installationIfcs") or []

    raw = Path(args.raw_root) / args.building
    arch = raw / arch_rel
    installs = [raw / r for r in install_rels]
    for p in [arch, *installs]:
        if not p.exists():
            fail(f"IFC file not found: {p}")

    extracted = extract_architecture(arch)
    out = {
        "meta": {
            "generatedBy": "build-spatial-hierarchy.py",
            "architectureIfc": arch_rel,
            "installationIfcs": install_rels,
        },
        **extracted,
    }
    if installs:
        out["roomPlants"] = extract_room_plants(installs, load_reconcile().ifc_system_rule(profile))

    out_path = REPO / "data" / args.building / "inputs" / "ifc-spatial.json"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"\nIFC extract written: {out_path}")
    print(f"  building:   {out['building']['name']}")
    print(f"  storeys:    {len(out['storeys'])}")
    print(f"  spaces:     {len(out['spaces'])}")
    if "roomPlants" in out:
        print(f"  roomPlants: {len(out['roomPlants'])} room(s)")


if __name__ == "__main__":
    main()
