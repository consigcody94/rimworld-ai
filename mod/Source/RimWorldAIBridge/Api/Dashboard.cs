using System.Text;

namespace RimWorldAIBridge
{
    /// <summary>Tiny human-facing page at GET / so a person can watch what the AI sees.</summary>
    public static class Dashboard
    {
        public static byte[] Html()
        {
            const string html = @"<!doctype html>
<html><head><meta charset='utf-8'><title>RimWorld AI Bridge</title>
<meta name='viewport' content='width=device-width,initial-scale=1'>
<style>
:root{--bg:#14161a;--fg:#e6e2d3;--muted:#9a9483;--acc:#c9a44a;--card:#1d2026;--bad:#d9534f;--ok:#7bb26b}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 -apple-system,Segoe UI,Helvetica,Arial,sans-serif}
header{padding:14px 18px;border-bottom:1px solid #2b2f36;display:flex;gap:16px;align-items:baseline;flex-wrap:wrap}
h1{font-size:18px;margin:0;color:var(--acc)} .muted{color:var(--muted)}
main{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px;padding:14px 18px}
section{background:var(--card);border:1px solid #2b2f36;border-radius:8px;padding:12px 14px;min-height:80px}
h2{font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted);margin:0 0 8px}
table{width:100%;border-collapse:collapse} td,th{padding:3px 6px;text-align:left;border-bottom:1px solid #262a31;font-size:13px;vertical-align:top}
th{color:var(--muted);font-weight:500}
.bar{display:inline-block;height:8px;background:#2f343c;border-radius:4px;width:60px;vertical-align:middle;overflow:hidden}
.bar i{display:block;height:100%;background:var(--ok)} .bar.low i{background:var(--bad)}
pre{white-space:pre-wrap;margin:0;font-size:12px;color:#d6d2c4;max-height:320px;overflow:auto}
code{color:var(--acc)} .ev{padding:3px 0;border-bottom:1px solid #262a31} .k{color:var(--muted);font-size:11px;margin-right:6px}
img{max-width:100%;border-radius:6px;border:1px solid #2b2f36}
</style></head><body>
<header><h1>RimWorld AI Bridge</h1><span id='status' class='muted'>connecting…</span><span class='muted'>API docs: <a style='color:var(--acc)' href='/help'>/help</a></span></header>
<main>
<section><h2>Colony</h2><div id='colony' class='muted'>…</div></section>
<section><h2>Alerts</h2><div id='alerts' class='muted'>…</div></section>
<section style='grid-column:1/-1'><h2>Colonists</h2><table id='pawns'></table></section>
<section style='grid-column:1/-1'><h2>Recent events</h2><div id='events'></div></section>
<section style='grid-column:1/-1'><h2>Screen</h2><img id='shot' alt='screenshot' src=''></section>
</main>
<script>
const q=s=>document.querySelector(s);let since=0;const evs=[];
const tok=new URLSearchParams(location.search).get('token');const H=tok?{'X-Token':tok}:{};
async function j(u){const r=await fetch(u,{headers:H});return r.json()}
function bar(v){const p=Math.round((v||0)*100);return `<span class='bar ${p<30?'low':''}'><i style='width:${p}%'></i></span> ${p}%`}
async function tick(){try{
 const s=await j('/status');q('#status').textContent=s.playing?`${s.date} · speed ${s.speed}${s.paused?' (paused)':''} · tick ${s.tick}`:'no game loaded ('+s.programState+')';
 if(!s.playing){q('#colony').textContent='Load or start a game.';return}
 const c=await j('/colony');const m=c.map;
 q('#colony').innerHTML=`<b>${c.colonyName||''}</b> · ${m.biome} · ${m.weather}, ${m.outdoorTempC}°C, ${m.season}<br>Colonists ${m.colonists} · prisoners ${m.prisoners} · animals ${m.colonyAnimals} · hostiles <b style='color:${m.hostiles?'var(--bad)':'inherit'}'>${m.hostiles}</b><br>Wealth ${m.wealth} · food nutrition ${m.foodNutrition}<br><span class='muted'>${Object.entries(c.resources||{}).slice(0,10).map(([k,v])=>k+' '+v).join(' · ')}</span>`;
 q('#alerts').innerHTML=(c.alerts||[]).map(a=>`<div class='ev'><span class='k'>${a.priority}</span>${a.label}</div>`).join('')||'<span class=muted>none</span>';
 const p=await j('/pawns');
 q('#pawns').innerHTML='<tr><th>Name</th><th>Health</th><th>Food</th><th>Rest</th><th>Mood</th><th>Doing</th></tr>'+p.pawns.map(x=>`<tr><td><b>${x.name}</b> <span class=muted>#${x.id}${x.drafted?' ⚔':''}${x.downed?' ✖':''}</span></td><td>${bar(x.health.pct)}</td><td>${bar(x.needs?.food)}</td><td>${bar(x.needs?.rest)}</td><td>${bar(x.needs?.mood)}</td><td>${x.mentalState?'<b style=color:var(--bad)>'+x.mentalState+'</b> ':''}${x.job?.report||''}</td></tr>`).join('');
 const e=await j('/events?since='+since+'&limit=50');for(const x of e.events){since=x.seq;evs.unshift(x)}evs.length=Math.min(evs.length,40);
 q('#events').innerHTML=evs.map(x=>`<div class='ev'><span class='k'>${x.kind} t${x.tick}</span>${x.label?'<b>'+x.label+'</b> ':''}${x.text}</div>`).join('');
}catch(err){q('#status').textContent='error: '+err.message}}
async function shot(){try{const r=await fetch('/screenshot?width=900',{headers:H});if(r.ok){const b=await r.blob();q('#shot').src=URL.createObjectURL(b)}}catch(e){}}
tick();shot();setInterval(tick,3000);setInterval(shot,8000);
</script></body></html>";
            return Encoding.UTF8.GetBytes(html);
        }
    }
}
