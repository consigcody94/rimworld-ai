# What the game files actually say

Every number here was read out of RimWorld's own data at
`/Applications/RimWorld.app/Data/Core/Defs/`, not from a wiki page and not from memory. Each
section ends with what the agent believed before, because in several cases the belief was wrong
and it cost a colony.

## Work types, in the game's own priority order

`Defs/WorkTypeDefs/` sets a `naturalPriority` on every work type. This is the order RimWorld
itself considers them when a pawn looks for a job at equal manual priority:

    1400 Firefighter    1350 Patient       1300 Doctor        1200 PatientBedRest
    1150 BasicWorker    1100 Warden        1050 Handling      1000 Cooking
     950 Hunting         900 Construction   700 Growing        600 Mining
     500 PlantCutting    470 Smithing       450 Tailoring      430 Art
     400 Crafting        300 Hauling        200 Cleaning       100 Research

Two things follow that the agent had wrong:

**Harvesting a crop is Growing, not PlantCutting.** `Defs/WorkGiverDefs/` puts `GrowerHarvest`
(priority 100) under Growing, alongside `GrowerSow` (50). Only `PlantsCut` and `ExtractTree` sit
under PlantCutting. So a designated wild berry bush or a felled tree is PlantCutting work, while
rice ripening in a growing zone is Growing work. Suppressing Growing during a food emergency
therefore stops the harvest of the very crop that ends the emergency.

**Delivering materials to a blueprint is Construction work, not only Hauling.** Construction
carries `ConstructDeliverResourcesToBlueprints` (60) and `ConstructDeliverResourcesToFrames`
(70); Hauling's equivalents sit at 9 and 10. Keeping Hauling low does not starve a build site,
because the builder fetches its own materials. That removes the reason to ever raise Hauling
above 3, which used to eat whole days.

## Plants

From `Defs/ThingDefs_Plants/`:

| plant | harvest | harvestMinGrowth | yield | growDays |
|---|---|---|---|---|
| Plant_Rice | RawRice | 0.65 | 6 | 3.0 |
| Plant_Potato | RawPotatoes | 0.65 | 11 | 5.8 |
| Plant_Corn | RawCorn | 0.65 | 22 | 11.3 |
| Plant_Berry (wild) | RawBerries | 0.65 | 10 | 6.0 |
| Plant_Strawberry | RawBerries | 0.65 | 8 | 4.6 |
| Plant_Agave | RawAgave | 0.65 | 10 | 6.0 |
| Glowstool | RawFungus | 0.65 | 20 | 40 |

**`harvestMinGrowth` is 0.65 for every Core plant.** The agent used to designate anything above
0.32 growth, a number invented rather than read. RimWorld refuses the harvest job below the
threshold, so those designations sent a starving colonist across the map for a job that was
cancelled when it arrived.

Rice at 3 grow days and 6 yield per plant is by far the fastest way out of a food crisis: a
49-cell field is roughly nine days of food for one colonist, three days after sowing.

Plant_Berry needs `fertilityMin` 0.5, so it will not grow on gravel.

## Building costs and, more importantly, build time

From `Defs/ThingDefs_Buildings/`. `stuff` is the material count; `work` is the labour, and it is
the number that decides whether a lone colonist can afford the thing today.

| building | costList | stuff | work |
|---|---|---|---|
| Wall | - | 5 | 135 |
| Door | - | 25 | 850 |
| Bed | - | 45 | 800 |
| Stool | - | 25 | 450 |
| **DiningChair** | - | 45 | **8000** |
| Table1x2c | - | 28 | 750 |
| Table2x2c | - | 50 | 1500 |
| Campfire | WoodLog x20 | - | 200 |
| TableButcher | WoodLog x20 | 75 | 2000 |
| FueledStove | Steel x80 | - | 2000 |
| SimpleResearchBench | Steel x25 | 75 | 2800 |
| TrapSpike | - | 45 | 3200 |
| Cooler | Steel x90, Component x3 | - | 1600 |

**A dining chair is eighteen times the labour of a stool** for the same seat at the same table.
Early on that is most of a colonist's day. Always stool first.

A seven by seven room with four doors is 20 walls and 4 doors: 200 stuff and 6100 work. At
Construction 4 with ConstructionSpeed well under 1, that is most of two in-game days of one
colonist's time, which is the honest reason a house does not appear on day one.

The cold room needs a **Cooler**, which is 90 steel and 3 components. Neither is available in a
neolithic start, so the cold room is gated on mining and trade, not on wood.

## Mood

`Defs/ThoughtDefs/` carries every value. The ones that decide an early colony, all verified:

| thought | mood | note |
|---|---|---|
| NeedFood, extreme starvation | -44 | the last stage before death |
| NeedFood, starving | -32 | |
| NeedFood, badly malnourished | -26 | |
| AteHumanlikeMeatDirect | -20 | raw cannibalism |
| SleptOutside | -4 | one day, stack limit 1 |
| SleptInCold | -4 | |
| SleptOnGround | -4 | |
| AteWithoutTable | -3 | |

The full sorted table is in `mood.txt`. Sleeping rough is three separate -4 thoughts that stack
to -12 every night, which is why a bed under a roof outranks almost anything else the colony can
spend wood on.

## What to read from the game instead of from a file

Animal danger resolves through deep `ParentName` inheritance in `ThingDefs_Races/`, so parsing
the XML for it is unreliable. The live game has already resolved it: `GET /survey` reports each
nearby animal's `bodySize`, `predator`, `manhunterChance`, `meat` and a `safeToHuntBarehanded`
flag computed from them. Use that, not a hardcoded list of animal names — a hardcoded list is
what made the agent report "no safe game within seventy five cells" while a quail stood twenty
cells away.

The same rule applies generally: **design constants come from the def files, resolved runtime
state comes from the game.** Guessing at either is what produced every bug in this list.
