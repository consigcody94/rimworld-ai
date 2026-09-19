using System;
using System.Collections.Generic;
using System.Linq;
using RimWorld;
using RimWorld.Planet;
using UnityEngine;
using Verse;

namespace RimWorldAIBridge
{
    public static partial class Routes
    {
        private static void RegisterTrade(HttpServer s)
        {
            Doc(s, "GET", "/traders", "List all active traders on the map (caravans and orbital ships) plus the best colony negotiator.", r =>
            {
                Lookup.RequirePlaying();
                var map = Lookup.MapFrom(r);
                var tradersList = new List<Dictionary<string, object>>();

                // 1. Ground traders (pawns with CanTradeNow or TraderKind)
                if (map.mapPawns != null)
                {
                    foreach (var p in map.mapPawns.AllPawnsSpawned)
                    {
                        if (p.Dead || p.Downed) continue;
                        var it = p as ITrader;
                        if (it != null && (it.CanTradeNow || p.trader != null))
                        {
                            tradersList.Add(new Dictionary<string, object>
                            {
                                { "id", p.ThingID },
                                { "name", p.LabelShort },
                                { "traderName", it.TraderName },
                                { "traderKind", it.TraderKind?.defName },
                                { "faction", p.Faction?.Name },
                                { "canTradeNow", it.CanTradeNow },
                                { "type", "caravan" },
                                { "position", Lookup.Cell(p.Position) }
                            });
                        }
                    }
                }

                // 2. Orbital passing ships
                if (map.passingShipManager != null)
                {
                    foreach (var ship in map.passingShipManager.passingShips.OfType<TradeShip>())
                    {
                        tradersList.Add(new Dictionary<string, object>
                        {
                            { "id", ship.name },
                            { "name", ship.name },
                            { "traderName", ship.TraderName },
                            { "traderKind", ship.TraderKind?.defName },
                            { "faction", ship.Faction?.Name },
                            { "canTradeNow", ship.CanTradeNow },
                            { "type", "orbital" }
                        });
                    }
                }

                // Best colonist negotiator
                var bestNegotiator = GetBestNegotiator(map);

                return new Dictionary<string, object>
                {
                    { "traders", tradersList },
                    { "negotiator", bestNegotiator != null ? new Dictionary<string, object>
                        {
                            { "id", bestNegotiator.ThingID },
                            { "name", bestNegotiator.LabelShort },
                            { "social", bestNegotiator.skills?.GetSkill(SkillDefOf.Social)?.Level ?? 0 }
                        } : null
                    }
                };
            });

            Doc(s, "GET", "/trade", "Inspect the currently active trade session catalog, silver reserves, and item prices.", r =>
            {
                Lookup.RequirePlaying();
                if (!TradeSession.Active || TradeSession.deal == null)
                {
                    return new Dictionary<string, object> { { "active", false } };
                }

                var deal = TradeSession.deal;
                var list = new List<Dictionary<string, object>>();

                float colonySilver = 0f;
                float traderSilver = 0f;

                foreach (var t in deal.AllTradeables)
                {
                    if (t.IsCurrency)
                    {
                        colonySilver = t.CountHeldBy(Transactor.Colony);
                        traderSilver = t.CountHeldBy(Transactor.Trader);
                    }

                    list.Add(new Dictionary<string, object>
                    {
                        { "def", t.ThingDef?.defName },
                        { "label", t.Label },
                        { "countColony", t.CountHeldBy(Transactor.Colony) },
                        { "priceSell", Math.Round(t.GetPriceFor(TradeAction.PlayerSells), 2) },
                        { "countTrader", t.CountHeldBy(Transactor.Trader) },
                        { "priceBuy", Math.Round(t.GetPriceFor(TradeAction.PlayerBuys), 2) },
                        { "countToTransfer", t.CountToTransfer },
                        { "isCurrency", t.IsCurrency }
                    });
                }

                return new Dictionary<string, object>
                {
                    { "active", true },
                    { "trader", TradeSession.trader?.TraderName },
                    { "negotiator", TradeSession.playerNegotiator?.LabelShort },
                    { "colonySilver", colonySilver },
                    { "traderSilver", traderSilver },
                    { "tradeables", list }
                };
            });

            Doc(s, "ANY", "/trade/open", "Open a trade session with a specified trader. {trader:idOrName, negotiator:idOrName, showDialog:true}", r =>
            {
                Lookup.RequirePlaying();
                var map = Lookup.MapFrom(r);
                string traderArg = r.Arg("trader");
                var trader = FindTrader(map, traderArg) ?? throw new BridgeException("No trade caravan or ship available to trade with.");

                var negotiator = !string.IsNullOrEmpty(r.Arg("negotiator")) ? Lookup.PawnFrom(r, map) : GetBestNegotiator(map);
                if (negotiator == null) throw new BridgeException("No conscious, capable colonist available to act as negotiator.");

                // Close existing session if any
                if (TradeSession.Active) TradeSession.Close();

                TradeSession.SetupWith(trader, negotiator, false);

                bool showDialog = r.ArgBool("showDialog", true);
                if (showDialog)
                {
                    var existing = Find.WindowStack.Windows.OfType<Dialog_Trade>().FirstOrDefault();
                    if (existing == null)
                    {
                        Find.WindowStack.Add(new Dialog_Trade(negotiator, trader));
                    }
                }

                return Bridge.Ok(
                    "opened", true,
                    "trader", trader.TraderName,
                    "negotiator", negotiator.LabelShort,
                    "itemsAvailable", TradeSession.deal?.AllTradeables?.Count ?? 0
                );
            });

            Doc(s, "ANY", "/trade/deal", "Adjust trade quantities and execute deal. {buy:[{def,count}], sell:[{def,count}], execute:true}", r =>
            {
                Lookup.RequirePlaying();
                if (!TradeSession.Active || TradeSession.deal == null)
                {
                    throw new BridgeException("No trade session active. Call POST /trade/open first.");
                }

                var deal = TradeSession.deal;

                // 1. Process Sells
                var sellList = Json.List(r.Body, "sell");
                if (sellList != null)
                {
                    foreach (var obj in sellList.OfType<Dictionary<string, object>>())
                    {
                        string defName = obj.TryGetValue("def", out var d) ? d?.ToString() : null;
                        int count = obj.TryGetValue("count", out var c) ? Convert.ToInt32(c) : 0;
                        if (string.IsNullOrEmpty(defName) || count <= 0) continue;

                        var t = deal.AllTradeables.FirstOrDefault(x => x.ThingDef?.defName == defName);
                        if (t != null)
                        {
                            int maxSell = t.CountHeldBy(Transactor.Colony);
                            int toSell = Math.Min(count, maxSell);
                            t.AdjustTo(-toSell);
                        }
                    }
                }

                // 2. Process Buys
                var buyList = Json.List(r.Body, "buy");
                if (buyList != null)
                {
                    foreach (var obj in buyList.OfType<Dictionary<string, object>>())
                    {
                        string defName = obj.TryGetValue("def", out var d) ? d?.ToString() : null;
                        int count = obj.TryGetValue("count", out var c) ? Convert.ToInt32(c) : 0;
                        if (string.IsNullOrEmpty(defName) || count <= 0) continue;

                        var t = deal.AllTradeables.FirstOrDefault(x => x.ThingDef?.defName == defName);
                        if (t != null)
                        {
                            int maxBuy = t.CountHeldBy(Transactor.Trader);
                            int toBuy = Math.Min(count, maxBuy);
                            t.AdjustTo(toBuy);
                        }
                    }
                }

                bool execute = r.ArgBool("execute", true);
                bool actuallyTraded = false;
                bool executed = false;

                if (execute)
                {
                    executed = deal.TryExecute(out actuallyTraded);
                    var dialog = Find.WindowStack.Windows.OfType<Dialog_Trade>().FirstOrDefault();
                    if (dialog != null) Find.WindowStack.TryRemove(dialog);
                    if (TradeSession.Active) TradeSession.Close();
                }

                return Bridge.Ok("executed", executed, "actuallyTraded", actuallyTraded);
            });

            Doc(s, "ANY", "/trade/auto", "Autonomous one-step trade: sells surplus leathers/apparel/drugs, buys high-value components/medicine, executes and closes. {trader:idOrName}", r =>
            {
                Lookup.RequirePlaying();
                var map = Lookup.MapFrom(r);
                string traderArg = r.Arg("trader");
                var trader = FindTrader(map, traderArg) ?? throw new BridgeException("No trade caravan or ship available to trade with.");

                var negotiator = GetBestNegotiator(map) ?? throw new BridgeException("No capable colonist negotiator available.");

                if (TradeSession.Active) TradeSession.Close();
                TradeSession.SetupWith(trader, negotiator, false);

                var deal = TradeSession.deal;
                var bought = new List<string>();
                var sold = new List<string>();

                // Step A: Sell excess items to generate silver
                foreach (var t in deal.AllTradeables)
                {
                    if (t.IsCurrency || !t.TraderWillTrade) continue;
                    int held = t.CountHeldBy(Transactor.Colony);
                    if (held <= 0) continue;

                    string def = t.ThingDef?.defName ?? "";

                    // Sell leathers above 80
                    if (t.ThingDef?.IsLeather == true || t.ThingDef?.IsWool == true)
                    {
                        if (held > 80)
                        {
                            int sellCount = held - 80;
                            t.AdjustTo(-sellCount);
                            sold.Add($"{sellCount}x {t.Label}");
                        }
                    }
                    // Sell excess social drugs above 25
                    else if (def == "SmokeleafJoint" || def == "PsychiteTea")
                    {
                        if (held > 25)
                        {
                            int sellCount = held - 25;
                            t.AdjustTo(-sellCount);
                            sold.Add($"{sellCount}x {t.Label}");
                        }
                    }
                    // Sell art / sculptures
                    else if (t.ThingDef?.category == ThingCategory.Building && t.ThingDef.IsArt)
                    {
                        t.AdjustTo(-held);
                        sold.Add($"{held}x {t.Label}");
                    }
                }

                // Step B: Buy priority survival items (Components, Advanced Components, Medicine, Neutroamine)
                var priorityBuys = new[] { "ComponentIndustrial", "ComponentSpacer", "MedicineIndustrial", "Neutroamine", "MedicineUltratech" };
                foreach (var defName in priorityBuys)
                {
                    var t = deal.AllTradeables.FirstOrDefault(x => x.ThingDef?.defName == defName);
                    if (t != null && t.TraderWillTrade)
                    {
                        int available = t.CountHeldBy(Transactor.Trader);
                        if (available > 0)
                        {
                            float buyPrice = t.GetPriceFor(TradeAction.PlayerBuys);
                            float curSilver = deal.CurrencyTradeable?.CountPostDealFor(Transactor.Colony) ?? 0;
                            int affordable = buyPrice > 0 ? Mathf.FloorToInt(curSilver / buyPrice) : available;
                            int toBuy = Math.Min(available, Math.Max(0, affordable));
                            if (toBuy > 0)
                            {
                                t.AdjustTo(toBuy);
                                bought.Add($"{toBuy}x {t.Label}");
                            }
                        }
                    }
                }

                bool executed = false;
                bool traded = false;
                if (bought.Count > 0 || sold.Count > 0)
                {
                    executed = deal.TryExecute(out traded);
                }

                var dialog = Find.WindowStack.Windows.OfType<Dialog_Trade>().FirstOrDefault();
                if (dialog != null) Find.WindowStack.TryRemove(dialog);
                if (TradeSession.Active) TradeSession.Close();

                return Bridge.Ok("executed", executed, "actuallyTraded", traded, "bought", bought, "sold", sold);
            });

            Doc(s, "ANY", "/trade/close", "Close the active trade session and any open trade dialog window.", r =>
            {
                Lookup.RequirePlaying();
                var dialog = Find.WindowStack?.Windows.OfType<Dialog_Trade>().FirstOrDefault();
                if (dialog != null) Find.WindowStack.TryRemove(dialog);
                if (TradeSession.Active) TradeSession.Close();
                return Bridge.Ok("closed", true);
            });
        }

        private static Pawn GetBestNegotiator(Map map)
        {
            if (map.mapPawns == null) return null;
            return map.mapPawns.FreeColonistsSpawned
                .Where(p => !p.Downed && !p.Dead && !p.InMentalState && p.health != null && p.health.capacities.CapableOf(PawnCapacityDefOf.Talking))
                .OrderByDescending(p => p.skills?.GetSkill(SkillDefOf.Social)?.Level ?? 0)
                .FirstOrDefault();
        }

        private static ITrader FindTrader(Map map, string traderIdOrName)
        {
            if (map.passingShipManager != null)
            {
                foreach (var ship in map.passingShipManager.passingShips.OfType<TradeShip>())
                {
                    if (string.IsNullOrEmpty(traderIdOrName) ||
                        ship.name.IndexOf(traderIdOrName, StringComparison.OrdinalIgnoreCase) >= 0 ||
                        ship.TraderName.IndexOf(traderIdOrName, StringComparison.OrdinalIgnoreCase) >= 0)
                    {
                        return ship;
                    }
                }
            }

            if (map.mapPawns != null)
            {
                var candidates = map.mapPawns.AllPawnsSpawned
                    .Where(p => !p.Dead && !p.Downed && p is ITrader it && (it.CanTradeNow || p.trader != null))
                    .ToList();

                if (!string.IsNullOrEmpty(traderIdOrName))
                {
                    var exact = candidates.FirstOrDefault(p =>
                        p.ThingID.Equals(traderIdOrName, StringComparison.OrdinalIgnoreCase) ||
                        p.LabelShort.IndexOf(traderIdOrName, StringComparison.OrdinalIgnoreCase) >= 0 ||
                        (p as ITrader)?.TraderName.IndexOf(traderIdOrName, StringComparison.OrdinalIgnoreCase) >= 0);
                    if (exact != null) return exact as ITrader;
                }

                return candidates.FirstOrDefault(p => (p as ITrader)?.CanTradeNow == true) as ITrader ?? candidates.FirstOrDefault() as ITrader;
            }

            return null;
        }
    }
}
