#!/usr/bin/env python3
"""
Read the installed RimWorld's own Defs and write the numbers the colony agent fights with.

    python3 scripts/extract-game-data.py [/Applications/RimWorld.app]

Writes reference/game-data.json:
  animals  kind label -> combat power, move speed, body size, revenge chance, predator
  weapons  weapon label -> ranged?, range, warmup, melee-only
  intro    the storyteller's scripted first-week incidents (read from Assembly-CSharp by hand;
           see the comment on INTRO_EVENTS in colony-agent.mjs)

The agent used to guess all of this. It fought a vulture (combat power 40, flies) on the
strength of "an animal with no weapon is worth 3", and ordered a bow shot at a target 30 cells
away. The game already knows both answers.
"""
import glob
import json
import os
import sys
import xml.etree.ElementTree as ET

APP = sys.argv[1] if len(sys.argv) > 1 else "/Applications/RimWorld.app"
DATA = os.path.join(APP, "Data")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "reference", "game-data.json")

things, thing_names, kinds, kind_names = {}, {}, {}, {}
for f in sorted(glob.glob(os.path.join(DATA, "**", "Defs", "**", "*.xml"), recursive=True)):
    try:
        root = ET.parse(f).getroot()
    except ET.ParseError:
        continue
    source = os.path.relpath(f, DATA).split(os.sep)[0]
    for el in root:
        if el.tag not in ("ThingDef", "PawnKindDef"):
            continue
        rec = {"el": el, "parent": el.get("ParentName"), "source": source}
        name, def_name = el.get("Name"), el.findtext("defName")
        if el.tag == "ThingDef":
            if name: thing_names[name] = rec
            if def_name: things[def_name] = rec
        else:
            if name: kind_names[name] = rec
            if def_name: kinds[def_name] = rec


def lookup(rec, path, table):
    """A field, walking ParentName inheritance the way the game does for simple values."""
    for _ in range(25):
        if rec is None:
            return None
        node = rec["el"].find(path)
        if node is not None and (node.text or "").strip():
            return node.text.strip()
        rec = table.get(rec["parent"]) if rec["parent"] else None
    return None


def ancestry(rec, table):
    chain = []
    for _ in range(25):
        if rec is None:
            break
        chain.append(rec["el"].get("Name") or rec["el"].findtext("defName") or "")
        rec = table.get(rec["parent"]) if rec["parent"] else None
    return chain


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


animals = {}
for def_name, kind in kinds.items():
    race = lookup(kind, "race", kind_names)
    if not race or race not in things:
        continue
    thing = things[race]
    chain = ancestry(thing, thing_names)
    if not any("Animal" in c or "Bird" in c for c in chain):
        continue
    label = (lookup(kind, "label", kind_names) or lookup(thing, "label", thing_names) or def_name).lower()
    animals[label] = {
        "def": def_name,
        "combatPower": num(lookup(kind, "combatPower", kind_names)),
        "moveSpeed": num(lookup(thing, "statBases/MoveSpeed", thing_names)),
        "bodySize": num(lookup(thing, "race/baseBodySize", thing_names)),
        "revengeChance": num(lookup(thing, "race/manhunterOnDamageChance", thing_names)),
        "predator": lookup(thing, "race/predator", thing_names) == "true",
        # Odyssey birds carry MaxFlightTime; a flying animal cannot be outrun on foot.
        "flies": num(lookup(thing, "statBases/MaxFlightTime", thing_names)) is not None,
        "source": kind["source"],
    }

# Humanlike pawn kinds (raiders, tribals, drifters), keyed by the label the bridge reports as
# `kind`. The day-6 intro raid is 40 points: in practice a single drifter or tribal.
people = {}
for def_name, kind in kinds.items():
    race = lookup(kind, "race", kind_names)
    if race != "Human":
        continue
    label = (lookup(kind, "label", kind_names) or def_name).lower()
    power = num(lookup(kind, "combatPower", kind_names))
    if power is None:
        continue
    # Several defs share a label ("tribal warrior" exists per faction); keep the strongest.
    if label not in people or power > people[label]["combatPower"]:
        people[label] = {"def": def_name, "combatPower": power, "source": kind["source"]}

weapons = {}
for def_name, thing in things.items():
    if thing["el"].get("Abstract") == "True":
        continue
    chain = ancestry(thing, thing_names)
    if not any("Weapon" in c or "Gun" in c or "Bow" in c for c in chain):
        continue
    label = lookup(thing, "label", thing_names)
    if not label:
        continue
    verb_range = None
    warmup = None
    for rec in [thing] + [thing_names.get(n) for n in chain[1:]]:
        if rec is None:
            continue
        verbs = rec["el"].find("verbs")
        if verbs is not None:
            for li in verbs:
                verb_range = verb_range or num(li.findtext("range"))
                warmup = warmup or num(li.findtext("warmupTime"))
        if verb_range:
            break
    weapons[label.lower()] = {
        "def": def_name,
        "ranged": bool(verb_range and verb_range > 1.5),
        "range": verb_range,
        "warmup": warmup,
        "source": thing["source"],
    }

human = things.get("Human")
data = {
    "generatedFrom": APP,
    "version": open(os.path.join(APP, "Version.txt")).read().strip() if os.path.exists(os.path.join(APP, "Version.txt")) else None,
    "humanMoveSpeed": num(lookup(human, "statBases/MoveSpeed", thing_names)) if human else 4.6,
    "animals": dict(sorted(animals.items())),
    "people": dict(sorted(people.items())),
    "weapons": dict(sorted(weapons.items())),
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w") as fh:
    json.dump(data, fh, indent=1, sort_keys=False)
    fh.write("\n")
print(f"{len(animals)} animals, {len(people)} humanlike kinds, {len(weapons)} weapons -> {os.path.relpath(OUT)}")
