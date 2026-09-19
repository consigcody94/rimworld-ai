export const PLAY_GUIDE = `# Playing RimWorld through the AI Bridge

## The loop
1. rimworld_colony: read the situation (alerts, colonists, hostiles, resources, letters).
2. Decide: pick the highest-impact actions (threats > medical > food > shelter > mood > growth).
3. Act with the order tools (draft/move/attack, designate, build, zones, bills, work priorities, research).
4. rimworld_wait (600-2500 ticks; 2500 = one in-game hour, 60000 = a day) then rimworld_events with the last 'latest' seq.
5. Repeat. Every few days rimworld_game_save.

## Coordinates
x grows east, z grows north. rimworld_grid rows[0] is the TOP (highest z). rimworld_cell inspects one cell. Buildings need a valid, unfogged, walkable cell; rimworld_build returns the game's own reason when placement fails.

## Priorities that keep colonists alive
- Raid/threat: draft shooters, move them behind cover or into a doorway, rimworld_attack the nearest enemy; undraft afterwards or they will not eat or sleep.
- Injuries: ensure someone has Doctor priority 1 and a bed exists; a downed colonist can be rescued with rimworld_job job=Rescue targetA=<pawn> targetB=<bed id>.
- Food: growing zone with Plant_Rice (fast) or Plant_Potato (poor soil) early; a butcher table and campfire/stove with a CookMealSimple bill set to target count; hunt with rimworld_designate type=hunt.
- Shelter: walls + door + roof happen automatically when a room is enclosed; beds (Bed, stuff WoodLog) indoors; a research bench.
- Mood: separate bedrooms, a table (TableShort/TableLong) with chairs (DiningChair), horseshoes pin or chess table for joy.
- Work: set 1-4 priorities per colonist based on skills (rimworld_pawn shows passions **). Everyone: Firefighter 1, Patient 1, PatientBedRest 1, Hauling/Cleaning 3-4.

## Useful defNames
Buildings: Wall, Door, Bed, DoubleBed, TableShort, DiningChair, Campfire, FueledStove, ElectricStove, TableButcher, ResearchBench, TorchLamp, StandingLamp, Battery, WoodFiredGenerator, SolarGenerator, PowerConduit, Cooler, Heater, Sandbags, Turret_MiniTurret, Hospital bed = HospitalBed, Stockpile is a zone.
Materials (stuff): WoodLog, Steel, BlocksGranite, BlocksLimestone, BlocksSandstone, BlocksSlate, BlocksMarble, Plasteel, Cloth, Leather_*.
Plants: Plant_Rice, Plant_Potato, Plant_Corn, Plant_Healroot, Plant_Cotton, Plant_Haygrass, Plant_Strawberry.
Recipes: CookMealSimple, CookMealFine, ButcherCorpseFlesh, Make_MeleeWeapon_Club, Make_Apparel_Parka, Make_StoneBlocks... (search with rimworld_defs type=recipe).
Work types: Firefighter, Patient, Doctor, PatientBedRest, BasicWorker, Warden, Handling, Cooking, Hunting, Construction, Growing, Mining, PlantCutting, Smithing, Tailoring, Art, Crafting, Hauling, Cleaning, Research, Childcare (Biotech), DarkStudy (Anomaly).

## Etiquette
- Never leave pawns drafted after combat.
- Prefer designations and priorities (the colony's own AI executes them) over micromanaging jobs.
- Read letters (rimworld_letters) and answer quests deliberately; dismiss what you decline.
- Use rimworld_notify to tell the human spectator what you are doing and why.
- Save often (rimworld_game_save). If the bridge reports a force-pause, a dialog or letter is blocking: rimworld_letters / rimworld_dialog_close.
`;
