/*
 * Here Lies — app logic
 *
 * A single-page app with hash routing (#home, #ask, #challenges, #graveyard, #setup).
 * All state lives in one object (S) that is saved after every change:
 *   - inside Claude: to the per-user artifact database via window.claude.use("db")
 *   - anywhere else: to localStorage
 * The AI coach and screenshot reader use window.claude.use("sample") when it is
 * available and are hidden otherwise.
 */
(() => {
"use strict";
const D = 86400000, H = 3600000;
const CATS = ["Makeup","Clothes","Home","Other"];
const CHALLENGES = [
  {id:"nobuy7",  name:"7-Day No-Buy", blurb:"One week, zero impulse buys.", days:7, cats:null},
  {id:"closet",  name:"Shop Your Closet Week", blurb:"No new clothes. Restyle what you own.", days:7, cats:["Clothes"]},
  {id:"nomakeup",name:"No Makeup November", blurb:"Thirty days without new makeup.", days:30, cats:["Makeup"]},
  {id:"useitup", name:"Use It Up Month", blurb:"Finish what you have before buying makeup or home things.", days:30, cats:["Makeup","Home"]},
  {id:"nobuy30", name:"30-Day No-Buy", blurb:"A full month of keeping your money.", days:30, cats:null},
  {id:"nobuy90", name:"90-Day No-Buy", blurb:"The big one. A whole season.", days:90, cats:null}
];

/* ---------- helpers ---------- */
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const money = n => { n = Number(n)||0; return "$" + n.toLocaleString(undefined,{minimumFractionDigits:n%1?2:0,maximumFractionDigits:2}); };
const pad = n => String(n).padStart(2,"0");
const dayKey = (d = new Date()) => { const x = new Date(d); return x.getFullYear()+"-"+pad(x.getMonth()+1)+"-"+pad(x.getDate()); };
const parseDay = k => { const [y,m,d] = k.split("-").map(Number); return new Date(y,m-1,d); };
const daysBetween = (a,b) => Math.round((parseDay(b)-parseDay(a))/D);
const addDays = (k,n) => { const d = parseDay(k); d.setDate(d.getDate()+n); return dayKey(d); };
const today = () => dayKey();
const fmt = ms => new Date(ms).toLocaleDateString(undefined,{month:"short",day:"numeric"});
const fmtDay = k => parseDay(k).toLocaleDateString(undefined,{month:"short",day:"numeric"});
const uid = () => Math.random().toString(36).slice(2,10) + Date.now().toString(36);
const plural = (n,w) => n + " " + w + (n === 1 ? "" : "s");
const left = ms => { if (ms <= 0) return "ready now"; const h = Math.floor(ms/H), m = Math.ceil((ms%H)/60000); return h >= 24 ? "ready in " + plural(Math.ceil(ms/D),"day") : h ? `ready in ${h}h ${m}m` : `ready in ${m}m`; };

/* ---------- state ---------- */
const fresh = () => ({v:1, settings:{buddy:"", limit:25, waitHours:24, goalName:"", goalAmount:150},
  profile:{}, startedAt:null, streakStart:null, best:0, slips:[], freezes:{}, items:[], challenge:null, history:[], claimed:0, claims:[], exampleMode:false});
let S = fresh();
let mode = "loading"; // loading | cloud | device
let docRef = null, saveTimer = null;
let sampleFn = null, coachOff = false, imgOK = false;
let view = "home";
let gFilter = "All";
let ask = {step:"form", draft:null, chat:null, shot:null};
let sheet = null; // {type:'slip', ...}

const normalize = o => { const f = fresh(); const s = Object.assign(f, o || {}); s.settings = Object.assign(fresh().settings, (o||{}).settings || {}); s.items = s.items || []; s.slips = s.slips || []; s.freezes = s.freezes || {}; s.history = s.history || []; s.claims = s.claims || []; s.profile = s.profile || {}; return s; };

function save(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const body = JSON.parse(JSON.stringify(S));
    if (mode === "cloud" && docRef){
      try { await docRef.set(body); }
      catch(e){
        if (e && e.code === "unavailable"){ setTimeout(() => docRef.set(body).catch(() => toast("Couldn't save. Check your connection.")), 1500); }
        else toast("Couldn't save that change. Try again in a moment.");
      }
    } else {
      try { localStorage.setItem("herelies-v1", JSON.stringify(body)); } catch(e){}
    }
  }, 350);
}

async function initStore(){
  try {
    const c = window.claude;
    if (c && c.use){
      const user = await c.use("user");
      const id = user ? await user.id() : null;
      const db = await c.use("db");
      if (db && id){
        docRef = db.doc("data/users/" + id + "/app");
        const snap = await docRef.get();
        if (snap.exists) S = normalize(JSON.parse(JSON.stringify(snap.data())));
        mode = "cloud";
      }
      c.use("sample").then(fn => { sampleFn = fn; if (fn && fn.limits) fn.limits().then(l => { imgOK = !!(l && l.images); if (view === "ask") render(); }).catch(() => {}); if (view === "ask") render(); }).catch(() => {});
    }
  } catch(e){}
  if (mode !== "cloud"){
    mode = "device";
    try { const raw = localStorage.getItem("herelies-v1"); if (raw) S = normalize(JSON.parse(raw)); } catch(e){}
  }
  render(); hideSplash(); if (view === "home") setTimeout(countUp, Math.max(0, 1900 - (performance.now() - splashStart)));
}

/* ---------- derived ---------- */
const streak = () => S.streakStart ? Math.max(0, daysBetween(S.streakStart, today())) : 0;
const monthKey = () => today().slice(0,7);
const freezeLeft = () => !(S.freezes[monthKey()] >= 1);
const buried = () => S.items.filter(i => i.status === "buried");
const saved = () => buried().reduce((a,i) => a + (Number(i.price)||0), 0);
const fund = () => Math.max(0, saved() - (S.claimed||0));
const isReady = i => i.status === "waiting" && Date.now() >= i.readyAt;
const needsYou = () => S.items.filter(i => isReady(i) || i.status === "buddy" || i.status === "approved");
const waiting = () => S.items.filter(i => i.status === "waiting" && !isReady(i)).sort((a,b) => a.readyAt-b.readyAt);
const resurrectable = () => buried().filter(i => !i.revisited && Date.now() - (i.decidedAt||0) >= 30*D);
const chal = id => CHALLENGES.find(c => c.id === id);
const buddyName = () => S.settings.buddy || "your buddy";

function housekeeping(){
  let changed = false;
  const s = streak();
  if (s > (S.best||0)){ S.best = s; changed = true; }
  if (S.challenge){
    const c = chal(S.challenge.id);
    if (c && daysBetween(S.challenge.start, today()) >= c.days){
      S.history.push({id:c.id, start:S.challenge.start, end:today(), result:"won"});
      S.challenge = null; changed = true;
      setTimeout(() => toast(c.name + " complete. Badge earned."), 300);
    }
  }
  if (changed) save();
}

/* ---------- graphics ---------- */
function candle(h = 34){
  return `<svg width="${Math.round(h*0.42)}" height="${h}" viewBox="0 0 20 48" aria-hidden="true">
    <circle class="glow" cx="10" cy="10" r="10" fill="#F2B14C"/>
    <path class="flame" d="M10 1 C14 7 13.5 13 10 16 C6.5 13 6 7 10 1 Z" fill="#F2B14C"/>
    <path class="flame" d="M10 7 C11.8 10 11.6 13 10 14.6 C8.4 13 8.2 10 10 7 Z" fill="#FFF1C9"/>
    <rect x="6" y="16" width="8" height="31" rx="1" fill="#F4ECDC" stroke="var(--ink)" stroke-width=".8"/>
    <path d="M6 18 C6 22 7.5 22 7.5 25" stroke="#E7DCC4" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`;
}
const candles = () => `<span class="candles">${candle(34)}${candle(26)}</span>`;
function tray(){
  return `<svg class="serve" width="150" height="108" viewBox="0 0 150 108" role="img" aria-label="A gloved hand serving your reward on a silver tray">
    <path d="M0 108 V70 C10 64 26 62 44 66 L48 86 C30 86 14 92 0 108 Z" fill="#141217"/>
    <path d="M40 64 L50 62 L54 84 L44 86 Z" fill="#F4ECDC" stroke="#1B1A19" stroke-width="1"/>
    <path d="M52 66 C62 58 78 56 92 54 C98 54 98 60 92 61 L80 63 C88 64 92 70 84 72 L58 80 Z" fill="#FFFDF7" stroke="#1B1A19" stroke-width="1.2"/>
    <ellipse cx="96" cy="52" rx="52" ry="7" fill="#C9CCD3" stroke="#1B1A19" stroke-width="1.2"/>
    <ellipse cx="96" cy="50" rx="44" ry="4" fill="#E7E9EE"/>
    <g class="lid"><path d="M64 48 C64 26 128 26 128 48 Z" fill="#D7DAE0" stroke="#1B1A19" stroke-width="1.2"/><circle cx="96" cy="26" r="4" fill="#D7DAE0" stroke="#1B1A19" stroke-width="1.2"/><path d="M74 42 C76 34 84 30 90 30" stroke="#FFFFFF" stroke-width="2" fill="none" stroke-linecap="round"/></g></svg>`;
}
function ripOverlay(i){
  const l = document.getElementById("layer"), d = document.createElement("div");
  d.className = "ripov"; d.setAttribute("role","status");
  d.innerHTML = `<div class="inner"><div class="row3">${candle(44)}<div class="stone"><span style="font-family:var(--display);font-weight:700;letter-spacing:.22em">R.I.P.</span>
    <span style="font-family:var(--display);font-style:italic;font-size:19px;line-height:1.15;overflow-wrap:anywhere">${esc(i.name)}</span>
    <span style="font-family:var(--display);font-weight:700;font-size:24px">${money(i.price)}</span><span style="font-size:12px;letter-spacing:.14em;color:var(--muted)">${fmt(Date.now()).toUpperCase()}</span></div>${candle(44)}</div>
    <div class="dirt"></div><span class="say">Rest in peace</span><span style="font-size:15px">${money(i.price)} stays in your pocket.</span></div>`;
  l.appendChild(d);
  const close = () => d.remove(); d.addEventListener("click", close); setTimeout(close, 2600);
}


function catSilhouette(w = 64){
  return `<svg class="sil" width="${w}" height="${Math.round(w*1.25)}" viewBox="0 0 64 80" role="img" aria-label="Here Lies cat mark">
    <path class="tail-slow" d="M44 76 C60 76 62 60 56 52 C53 48 49 50 51 54" stroke="var(--ink)" stroke-width="3.4" fill="none" stroke-linecap="round"/>
    <path d="M18 78 C14 62 18 48 30 45 C42 48 46 62 42 78 Z" fill="var(--ink)"/>
    <path d="M30 18 C40 18 46 25 46 33 C46 41 39 46 30 46 C21 46 14 41 14 33 C14 25 20 18 30 18 Z" fill="var(--ink)"/>
    <path d="M16 28 L14 8 L27 19 Z M44 28 L46 8 L33 19 Z" fill="var(--ink)"/>
    <g class="slit"><path d="M21 32 Q24.5 30 28 32 M32 32 Q35.5 30 39 32" stroke="var(--bg)" stroke-width="1.6" fill="none" stroke-linecap="round"/></g></svg>`;
}

function councilArt(name){
  /* top-down boardroom, duotone blue on cream, after the reference photo */
  const suits = ["#2B3A5C","#5B6E94","#E9EFF8","#3E5179","#8FA3C8","#24304C","#E9EFF8","#5B6E94","#2B3A5C","#8FA3C8","#3E5179","#E9EFF8"];
  const hair  = ["#1B2338","#3A4766","#1B2338","#55658A","#1B2338","#2C3754","#3A4766","#1B2338","#55658A","#1B2338","#2C3754","#1B2338"];
  const props = ["laptop","","","papers","","cup","","","notes","","",""];
  const person = (n, you) => {
    const suit = suits[n], dark = suit === "#E9EFF8" ? "#B9C7E0" : "#16203A";
    const prop = props[n] === "laptop" ? `<g transform="translate(0,-25)"><rect x="-11" y="-7" width="22" height="14" rx="1.5" fill="#F7F9FD" stroke="#A9B9D6" stroke-width=".8"/><rect x="-9" y="-5" width="18" height="10" fill="#DCE6F5"/></g>`
      : props[n] === "papers" ? `<g transform="translate(-4,-26) rotate(-12)"><rect x="-6" y="-8" width="12" height="16" fill="#FFFFFF" stroke="#A9B9D6" stroke-width=".8"/><path d="M-4 -4 h8 M-4 -1 h8 M-4 2 h6" stroke="#C3CFE4" stroke-width=".8"/></g>`
      : props[n] === "notes" ? `<g transform="translate(5,-25) rotate(8)"><rect x="-5" y="-7" width="10" height="14" fill="#FFFFFF" stroke="#A9B9D6" stroke-width=".8"/></g>`
      : props[n] === "cup" ? `<circle cx="10" cy="-24" r="3.4" fill="#FFFFFF" stroke="#A9B9D6" stroke-width=".8"/>` : "";
    return `${prop}
      <path d="M-17 6 Q-18 22 -8 24 L8 24 Q18 22 17 6 Q17 2 13 2 L-13 2 Q-17 2 -17 6 Z" fill="#121828"/>
      <path d="M-13 4 Q-14 16 -6 18 L6 18 Q14 16 13 4 Z" fill="#1F2840"/>
      <g class="arms" style="animation-delay:${(n*0.53)%4}s">
        <path d="M-11 -1 L-9 -9 L-5 -16" stroke="${suit}" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
        <path d="M11 -1 L9 -9 L5 -16" stroke="${suit}" stroke-width="4.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
        <path d="M-11 -1 L-9 -9 L-5 -16" stroke="${dark}" stroke-opacity=".25" stroke-width=".7" fill="none"/>
        <path d="M11 -1 L9 -9 L5 -16" stroke="${dark}" stroke-opacity=".25" stroke-width=".7" fill="none"/>
        <circle cx="-4.6" cy="-17.4" r="2.3" fill="#D5DEEE"/><circle cx="4.6" cy="-17.4" r="2.3" fill="#D5DEEE"/></g>
      <ellipse cx="0" cy="3" rx="15" ry="8.5" fill="${suit}" stroke="${dark}" stroke-opacity=".35" stroke-width=".8"/>
      <path d="M-4 -3 L0 4 L4 -3" fill="#F4F7FC"/>
      <g class="nod" style="animation-delay:${(n*0.37)%2.6}s"><circle cx="0" cy="1" r="7.2" fill="${you ? "#7E95C2" : hair[n]}"/><ellipse cx="-2" cy="-1" rx="3" ry="2.2" fill="#FFFFFF" opacity=".14"/></g>`;
  };
  const seats = [[130,40,180]];
  [88,128,168,208,248].forEach(y => seats.push([64,y,90]));
  [88,128,168,208,248].forEach(y => seats.push([196,y,-90]));
  seats.push([130,292,0]);
  return `<svg class="council" viewBox="0 0 260 326" role="img" aria-label="Your table, waiting on ${esc(name)} to weigh in">
    <defs><linearGradient id="tbl" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#E6EDF8"/><stop offset=".55" stop-color="#D6E2F4"/><stop offset="1" stop-color="#C8D7EE"/></linearGradient>
    <radialGradient id="tblShine" cx=".35" cy=".3" r=".7"><stop offset="0" stop-color="#FFFFFF" stop-opacity=".55"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient></defs>
    <rect x="88" y="65" width="88" height="208" rx="2" fill="#AFC2E2" opacity=".28"/>
    <rect x="86" y="62" width="88" height="208" fill="url(#tbl)"/>
    <rect x="86" y="62" width="88" height="208" fill="url(#tblShine)"/>
    ${seats.map(([x,y,r],n) => `<g transform="translate(${x},${y}) rotate(${r})">${person(n, n === seats.length-1)}</g>`).join("")}
    <text x="130" y="322" text-anchor="middle" font-family="Jost,sans-serif" font-size="8" letter-spacing="2" fill="#6B645C">YOU</text></svg>`;
}


/* loading page */
const splashStart = performance.now();
(function buildSplash(){
  const tw = document.getElementById("splashTray"); if (tw) tw.innerHTML = tray();
  const sc = document.getElementById("splashCat"); if (sc) sc.innerHTML = catSilhouette(44);
  const bars = document.getElementById("ldbars"); if (!bars) return;
  let h = 7, html = "";
  for (let n = 0; n < 44; n++){ h = (h*31 + 17) % 97; const w = 1 + (h % 4); html += `<i style="width:${w}px;animation-delay:${n*28}ms"></i>`; if (h % 3 === 0) html += `<span style="width:${1 + h%3}px"></span>`; }
  bars.innerHTML = html;
})();
function hideSplash(){
  const s = document.getElementById("splash"); if (!s) return;
  const wait = Math.max(0, 1900 - (performance.now() - splashStart));
  setTimeout(() => { s.classList.add("out"); setTimeout(() => s.remove(), 600); }, wait);
}
setTimeout(hideSplash, 7000);
function barcode(seed){
  let h = 2166136261; for (const ch of String(seed)) { h ^= ch.charCodeAt(0); h = Math.imul(h,16777619)>>>0; }
  let x = 0, rects = "";
  while (x < 296){ h = Math.imul(h ^ (h>>>13), 1274126177)>>>0; const w = 1 + (h % 4); const gap = 1 + ((h>>>5) % 3); rects += `<rect x="${x}" y="0" width="${w}" height="34" fill="currentColor"/>`; x += w + gap; }
  return `<svg class="barcode" viewBox="0 0 300 34" preserveAspectRatio="none" aria-hidden="true">${rects}</svg>`;
}
const icon = {
  back:`<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>`
};

/* ---------- views ---------- */
function vHome(){
  if (!S.startedAt) return vWelcome();
  const s = streak(), need = needsYou(), wait = waiting(), goal = Number(S.settings.goalAmount)||0, f = fund();
  const goalPct = goal ? Math.min(100, Math.round(f/goal*100)) : 0, dayPct = Math.min(100, Math.round(s/30*100));
  const unlocked = s >= 30 && goal > 0 && f >= goal;
  const c = S.challenge && chal(S.challenge.id);
  const dateStr = new Date().toLocaleDateString(undefined,{weekday:"long", month:"long", day:"numeric"});
  const hr = new Date().getHours(), greet = hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : "Good evening";
  return `
  <div class="page-title"><span class="script">${esc(dateStr)}</span><h1>${greet}${(S.profile||{}).name ? ", <em>" + esc(S.profile.name) + "</em>" : ""}.</h1></div>
  ${S.exampleMode ? `<p class="hint">You're looking at example data. <button class="link" data-act="clearExamples">Remove it and set up my own</button></p>` : ""}
  <section class="hero-card" aria-label="Current streak">
    <span class="big num" id="streakNum">${s}</span>
    <div class="stack" style="gap:10px">
      <span class="eyebrow">Your streak</span>
      <h2>${s === 1 ? "night" : "nights"} without an impulse buy</h2>
      <p class="hint">Best ${plural(S.best||0,"night")} · freeze ${freezeLeft() ? "available" : "used"} this month</p>
      ${Number((S.profile||{}).monthlyFun) ? `<div class="stack" style="gap:6px;max-width:340px"><span class="hint">Fun money: ${money(spentThisMonth())} of ${money(S.profile.monthlyFun)} this month</span><div class="bar"><i style="width:${Math.min(100, Math.round(spentThisMonth()/S.profile.monthlyFun*100))}%"></i></div></div>` : ""}
      <div class="row" style="margin-top:6px"><a class="btn primary" href="#ask">I want something</a><button class="btn" data-act="slip">I bought something</button></div>
    </div>
  </section>
  <div class="grid">
    ${need.length ? `<section class="card span"><div class="section-h"><h2>Needs you</h2><span class="chip go">${need.length}</span></div>${need.map(itemNeeds).join("")}</section>` : ""}
    <section class="card wash">
      <div class="between"><span class="eyebrow">Reward fund</span>${unlocked ? `<span class="chip go">Unlocked</span>` : ""}</div>
      <div class="stats">
        <div class="stat"><strong class="num">${money(f)}</strong><span class="hint">toward ${esc(S.settings.goalName || "your reward")}${goal ? " · goal " + money(goal) : ""}</span></div>
        <div class="stat"><strong class="num">${Math.min(s,30)}/30</strong><span class="hint">nights to unlock</span></div>
      </div>
      <div class="stack" style="gap:8px">
        <div class="bar" role="img" aria-label="Fund ${goalPct}% of goal"><i style="width:${goalPct}%"></i></div>
        <div class="bar" role="img" aria-label="Streak ${dayPct}% of 30 nights"><i style="width:${dayPct}%;background:linear-gradient(90deg,#E2C79C,var(--gold))"></i></div>
      </div>
      ${unlocked ? `<div style="display:flex;justify-content:center">${tray()}</div><button class="btn primary" data-act="claim">Claim my ${esc(S.settings.goalName || "reward")}</button>` : `<p class="hint">At 30 nights with ${goal ? money(goal) : "your goal"} saved, you unlock one planned purchase that doesn't break your streak.</p>`}
    </section>
    <section class="card">
      ${c ? `<span class="eyebrow">Current challenge</span><h2 style="font-size:24px;font-style:italic">${esc(c.name)}</h2>
        <div class="bar"><i style="width:${Math.round(daysBetween(S.challenge.start,today())/c.days*100)}%"></i></div>
        <span class="hint">Day ${daysBetween(S.challenge.start,today())} of ${c.days}</span>`
      : `<span class="eyebrow">Challenges</span><h2 style="font-size:24px;font-style:italic">Give your streak a theme.</h2><p class="hint">No Makeup November, Shop Your Closet Week and more.</p><a class="btn small" href="#challenges" style="align-self:flex-start">Browse challenges</a>`}
    </section>
    ${wait.length ? `<section class="card span"><div class="section-h"><h2>Waiting room</h2><span class="chip">${wait.length}</span></div>
      ${wait.map(i => `<div class="item"><div class="between"><span class="name">${esc(i.name)}</span><span class="num">${money(i.price)}</span></div>
        <div class="row"><span class="chip" data-ready="${i.readyAt}">${left(i.readyAt - Date.now())}</span>${i.example ? `<span class="chip ex">example</span>` : ""}<button class="link" data-act="bury" data-id="${i.id}">Bury it now</button></div></div>`).join("")}</section>` : ""}
    <section class="card span">
      <div class="section-h"><h2>Streak calendar</h2><span class="eyebrow">Best run · ${plural(S.best||0,"night")}</span></div>
      ${heatmap()}
    </section>
  </div>`;
}

function itemNeeds(i){
  const meta = `<div class="between"><span class="name">${esc(i.name)}</span><span class="num">${money(i.price)}</span></div>`;
  const ex = i.example ? `<span class="chip ex">example</span>` : "";
  if (isReady(i)) return `<div class="item">${meta}<div class="row"><span class="chip go">Wait is over</span>${ex}</div>
    <p class="reason">"${esc(i.reason)}"</p><p style="font-family:var(--display);font-style:italic;font-size:24px">Still want it?</p>
    <div class="row"><button class="btn small primary" data-act="bury" data-id="${i.id}">Let it rest</button><button class="btn small" data-act="buy" data-id="${i.id}">I'm buying it</button></div></div>`;
  if (i.status === "buddy") return `<div class="item">${meta}<div class="row"><span class="chip">Waiting on ${esc(buddyName())}</span>${ex}</div>
    <div class="copybox" id="msg-${i.id}">${esc(buddyMsg(i))}</div>
    <div class="row"><button class="btn small" data-act="copy" data-id="${i.id}">Copy message</button></div>
    <span class="eyebrow">What did ${esc(buddyName())} say?</span>
    <div class="row"><button class="btn small" data-act="approve" data-id="${i.id}">Yes</button><button class="btn small primary" data-act="deny" data-id="${i.id}">No</button><button class="btn small" data-act="waitweek" data-id="${i.id}">Wait a week</button></div></div>`;
  if (i.status === "approved") return `<div class="item">${meta}<div class="row"><span class="chip go">${esc(buddyName())} approved</span>${ex}</div>
    <p class="hint">A planned purchase doesn't break your streak.</p>
    <div class="row"><button class="btn small" data-act="buyok" data-id="${i.id}">Bought it</button><button class="btn small primary" data-act="bury" data-id="${i.id}">Bury it anyway</button></div></div>`;
  return "";
}

let calOffset = 0;
function dayInfo(){
  const slipBy = {}; S.slips.forEach(x => { if (!x.freeze) slipBy[x.date] = (slipBy[x.date]||[]).concat(x); else if (!slipBy[x.date]) slipBy[x.date] = "freeze"; });
  const buryBy = {}; buried().forEach(i => { const k = dayKey(i.decidedAt); (buryBy[k] = buryBy[k] || []).push(i); });
  return {slipBy, buryBy};
}
function dayState(k, info){
  const t = today();
  if (k > t) return "future";
  if (!S.startedAt || k < S.startedAt) return "before";
  const sl = info.slipBy[k];
  if (sl === "freeze") return "freeze";
  if (sl) return "slip";
  return "clean";
}
function heatmap(){
  const info = dayInfo(), t = today();
  const base = parseDay(t); base.setDate(1); base.setMonth(base.getMonth() + calOffset);
  const y = base.getFullYear(), m = base.getMonth();
  const monthName = base.toLocaleDateString(undefined,{month:"long", year:"numeric"});
  const firstDow = new Date(y, m, 1).getDay(), dim = new Date(y, m+1, 0).getDate();
  const dows = Array.from({length:7}, (_,i) => new Date(2026,1,1+i).toLocaleDateString(undefined,{weekday:"narrow"}));
  let cells = "", clean = 0, kept = 0, buriedN = 0, slips = 0;
  for (let i = 0; i < firstDow; i++) cells += `<span class="cd empty" aria-hidden="true"></span>`;
  for (let d = 1; d <= dim; d++){
    const k = y + "-" + pad(m+1) + "-" + pad(d), st = dayState(k, info), b = info.buryBy[k] || [];
    const prev = dayState(addDays(k,-1), info), next = dayState(addDays(k,1), info);
    const runL = st === "clean" && (prev === "clean" || prev === "freeze") && d > 1 && (d - 1 + firstDow) % 7 !== 0;
    const runR = st === "clean" && (next === "clean" || next === "freeze") && d < dim && (d + firstDow) % 7 !== 0;
    if (st === "clean"){ clean++; } if (st === "slip") slips++;
    buriedN += b.length; kept += b.reduce((a,i) => a + (Number(i.price)||0), 0);
    let label = parseDay(k).toLocaleDateString(undefined,{weekday:"long", month:"long", day:"numeric"}) + ": ";
    label += st === "future" ? "upcoming" : st === "before" ? "before you started" : st === "slip" ? "bought something" : st === "freeze" ? "freeze used" : b.length ? `clean, ${plural(b.length,"impulse")} let go` : "clean";
    cells += `<span class="cd ${st}${runL?" rl":""}${runR?" rr":""}${k===t?" today":""}" title="${esc(label)}" aria-label="${esc(label)}">
      <span class="dn num">${d}</span>${b.length ? `<span class="dots">${b.slice(0,3).map(() => "<i></i>").join("")}</span>` : st === "slip" ? `<span class="mk">×</span>` : st === "freeze" ? `<span class="mk">❄︎</span>` : ""}</span>`;
  }
  const canNext = calOffset < 0, startD = S.startedAt ? parseDay(S.startedAt) : null;
  const canPrev = startD ? (startD.getFullYear() < y || (startD.getFullYear() === y && startD.getMonth() < m)) : false;
  return `<div class="cal">
    <div class="cal-head"><button class="icon-btn" type="button" data-act="calPrev" aria-label="Previous month" ${canPrev?"":"disabled"}>${icon.back}</button>
      <h3>${esc(monthName)}</h3>
      <button class="icon-btn" type="button" data-act="calNext" aria-label="Next month" ${canNext?"":"disabled"}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M9 5l7 7-7 7"/></svg></button></div>
    <div class="cal-grid" role="grid" aria-label="${esc(monthName)} streak calendar">${dows.map(w => `<span class="dow" aria-hidden="true">${w}</span>`).join("")}${cells}</div>
    <div class="cal-stats">
      <div><strong class="num">${clean}</strong><span>clean days</span></div>
      <div><strong class="num">${buriedN}</strong><span>let go</span></div>
      <div><strong class="num">${money(kept)}</strong><span>kept</span></div>
      <div><strong class="num">${slips}</strong><span>${slips === 1 ? "slip" : "slips"}</span></div>
    </div>
    <div class="legend"><span><i class="lg clean"></i>Clean day</span><span><i class="lg dot"></i>Let something go</span><span><i class="lg slip"></i>Bought</span><span><i class="lg freeze"></i>Freeze</span><span><i class="lg today"></i>Today</span></div>
  </div>`;
}

function vWelcome(){ if (!wiz || wiz.edit) startWizard(false); return vWizard(); }

function setupFields(){
  const st = S.settings;
  return `
    <label for="f-buddy">Accountability buddy<input id="f-buddy" name="buddy" maxlength="40" placeholder="Their first name" value="${esc(st.buddy)}" autocomplete="off"></label>
    <div class="grid2">
      <label for="f-limit">Ask buddy over<input id="f-limit" name="limit" type="number" inputmode="decimal" min="0" step="1" value="${esc(st.limit)}"></label>
      <label for="f-wait">Waiting room<select id="f-wait" name="waitHours">${[24,48,72].map(h => `<option value="${h}" ${+st.waitHours===h?"selected":""}>${h} hours</option>`).join("")}</select></label>
    </div>
    <div class="grid2">
      <label for="f-goal">Reward goal<input id="f-goal" name="goalName" maxlength="40" placeholder="e.g. Weekend trip" value="${esc(st.goalName)}"></label>
      <label for="f-goalamt">Goal amount<input id="f-goalamt" name="goalAmount" type="number" inputmode="decimal" min="0" step="1" value="${esc(st.goalAmount)}"></label>
    </div>
    <p class="hint">Anything at or over the buddy amount goes to ${esc(st.buddy || "your buddy")}. Everything under it waits in the waiting room first.</p>`;
}

function vAsk(){
  if (!S.startedAt) return vWelcome();
  const head = `<div class="page-title"><span class="script">Before you check out</span><h1>I want <em>something</em></h1></div>`;
  if (ask.step === "form"){
    const d = ask.draft || {};
    return `${head}
    <p class="muted">Write it down instead of checking out. Nothing gets bought from here.</p>
    ${(S.profile||{}).stopWhat ? `<p class="pquote">You said: “I want to stop buying ${esc(S.profile.stopWhat)}${S.profile.because ? " because " + esc(S.profile.because) : ""}.”</p>` : ""}
    ${lateRisk() ? `<p class="hint warn">It’s late, and you said late nights are when it gets you. Maybe sleep on this one.</p>` : ""}
    <form class="card" data-form="ask">
      ${imgOK && !coachOff ? shotBlock() : ""}
      <label for="a-name">What is it?<input id="a-name" name="name" required maxlength="60" placeholder="e.g. Glossy lip trio" value="${esc(d.name)}"></label>
      <div class="grid2">
        <label for="a-price">Price<input id="a-price" name="price" type="number" inputmode="decimal" min="0" step="0.01" required placeholder="0" value="${esc(d.price)}"></label>
        <label for="a-url">Link (optional)<input id="a-url" name="url" type="url" placeholder="https://" value="${esc(d.url)}"></label>
      </div>
      <fieldset style="border:none;padding:0;margin:0;display:flex;flex-direction:column;gap:6px">
        <legend class="eyebrow" style="margin-bottom:6px">Category</legend>
        <div class="seg">${CATS.map(c => `<label><input type="radio" name="cat" value="${c}" ${ (d.cat||"Makeup")===c ? "checked":""}><span>${c}</span></label>`).join("")}</div>
      </fieldset>
      <label for="a-reason">Why do you want it?<textarea id="a-reason" name="reason" required minlength="15" maxlength="400" placeholder="Be honest. What's making you want it right now?">${esc(d.reason)}</textarea>
        <span class="hint">At least 15 characters. Typing it out is half the trick.</span></label>
      <button class="btn primary" type="submit">Next</button>
    </form>`;
  }
  const d = ask.draft, toBuddy = routeFor(d) === "buddy";
  const dest = toBuddy ? `${esc(buddyName())} for approval` : `the waiting room for ${waitFor(d)} hours${waitFor(d) > (Number(S.settings.waitHours)||24) ? " (an extra day, since it’s one of your weak spots)" : ""}`;
  if (ask.step === "decide"){
    const coach = sampleFn && !coachOff;
    return `${head}
    <section class="card">
      <div class="between"><span class="name" style="font-family:var(--display);font-style:italic;font-size:22px">${esc(d.name)}</span><span class="num" style="font-family:var(--display);font-size:22px;font-weight:700">${money(d.price)}</span></div>
      <p class="reason">"${esc(d.reason)}"</p>
      ${toBuddy ? councilArt(buddyName()) : ""}
      <p>This goes to ${dest}.</p>
    </section>
    ${coach ? `<section class="card wash"><div class="stack" style="gap:6px"><h2 style="font-size:24px;font-style:italic;font-weight:400">Do I need this?</h2><p class="hint" style="font-size:14px">Three honest questions, then a verdict.</p></div>
      <button class="btn primary" data-act="coach">Talk it through</button></section>` : ""}
    <div class="stack">
      <button class="btn ${coach ? "" : "primary"}" data-act="route">Send to ${toBuddy ? esc(buddyName()) : "the waiting room"}</button>
      <button class="btn" data-act="buryDraft">Bury it now</button>
      <button class="link" data-act="editDraft">${icon.back} Edit</button>
    </div>`;
  }
  if (ask.step === "chat"){
    const ch = ask.chat;
    return `${head}
    <section class="card">
      <div class="between"><span class="eyebrow">Do I need this?</span><span class="hint">${esc(d.name)} · ${money(d.price)}</span></div>
      <div class="chat" id="chat">${chatHtml()}</div>
      ${ch.done ? "" : `<form class="row" data-form="chat" style="flex-wrap:nowrap"><label for="c-in" style="flex:1;min-width:0"><span class="hint" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Your answer</span><input id="c-in" name="msg" autocomplete="off" placeholder="${ch.busy ? "Thinking…" : "Your answer"}" ${ch.busy ? "disabled" : ""}></label>
        ${ch.busy ? `<button class="btn small" type="button" data-act="stop">Stop</button>` : `<button class="btn small primary" type="submit">Send</button>`}</form>`}
    </section>
    <div class="stack">
      ${ch.done ? `<button class="btn primary" data-act="buryDraft">Bury it now</button><button class="btn" data-act="route">Send to ${toBuddy ? esc(buddyName()) : "the waiting room"}</button>`
        : `<button class="link" data-act="skipCoach">Skip the coach</button>`}
    </div>`;
  }
  if (ask.step === "done"){
    const i = S.items.find(x => x.id === ask.lastId);
    if (!i) { ask = {step:"form", draft:null, chat:null, shot:null}; return vAsk(); }
    if (i.status === "buried") return `${head}
      <section class="card"><span style="font-family:var(--display);font-style:italic;font-size:40px;line-height:1">Let go.</span>
      <p><b>${money(i.price)}</b> added to your reward fund.</p><a class="btn primary" href="#graveyard">See the graveyard</a></section>`;
    if (i.status === "buddy") return `${head}
      <section class="card">${councilArt(buddyName())}<h2 style="font-size:22px">Send this to ${esc(buddyName())}</h2>
      <div class="copybox" id="msg-${i.id}">${esc(buddyMsg(i))}</div>
      <button class="btn primary" data-act="copy" data-id="${i.id}">Copy message</button>
      <p class="hint">Text it to them however you usually do. When they answer, record it on the Streak tab.</p></section>
      <a class="btn" href="#home">Done</a>`;
    return `${head}
      <section class="card"><h2 style="font-size:22px">In the waiting room</h2><p>Come back ${left(i.readyAt - Date.now()).replace("ready ","")} and decide if you still want it. Most of the time you won't.</p></section>
      <a class="btn primary" href="#home">Done</a>`;
  }
  return "";
}

function chatHtml(){
  const ch = ask.chat;
  return ch.turns.map(t => t.role === "assistant"
      ? `<div class="msg coach">${esc(t.content.replace(/VERDICT:\s*/i,""))}</div>`
      : `<div class="msg me">${esc(t.content)}</div>`).join("")
    + (ch.live != null ? `<div class="msg coach">${esc(ch.live || "Thinking…")}</div>` : "")
    + (ch.err ? `<p class="hint warn">${esc(ch.err)}</p>` : "")
    + (ch.done ? `<p class="verdict">${esc(ch.verdict)}</p>` : "");
}

function vGraveyard(){
  const all = buried().slice().sort((a,b) => b.decidedAt - a.decidedAt);
  const list = gFilter === "All" ? all : all.filter(i => i.cat === gFilter);
  const res = resurrectable()[0];
  const forgot = S.items.filter(i => i.forgotten).length;
  const avg = all.length ? Math.max(0, Math.round(all.reduce((a,i) => a + (i.decidedAt - i.createdAt), 0) / all.length / D * 10) / 10) : 0;
  return `
    <div class="page-title"><span class="script">The wishlist</span><h1><em>Graveyard</em></h1><p>Everything you wanted, let go of, and kept the money for.</p></div>
  <section class="card wash">
    <span class="eyebrow">Laid to rest</span>
    <div class="row" style="align-items:baseline"><span style="font-family:var(--display);font-size:56px;font-weight:700;line-height:1" class="num">${money(saved())}</span><span style="font-family:var(--display);font-style:italic;font-size:18px">kept</span></div>
    <span class="hint">${plural(all.length,"impulse")} buried · average ${avg} days from wanting to burying${forgot ? " · " + forgot + " forgotten for good" : ""}</span>
    <div class="scan">${barcode("herelies" + all.length)}</div>
    <span class="hint" style="text-align:center;letter-spacing:.3em;font-size:10px">R.I.P. · NO RECEIPT · NO REGRETS</span>
  </section>
  ${res ? `<section class="card"><span class="eyebrow">Resurrection check · buried ${fmt(res.decidedAt)}</span>
    <div class="row" style="gap:10px;align-items:flex-end;flex-wrap:nowrap">${candles()}<p style="font-family:var(--display);font-size:20px">Still thinking about the <i>${esc(res.name)}</i>?</p></div>
    <p class="reason">Your last words: "${esc(res.reason)}"</p>
    <div class="row"><button class="btn small primary" data-act="rip" data-id="${res.id}">Forgot it existed</button><button class="btn small" data-act="resurrect" data-id="${res.id}">Resurrect it</button></div>
    <p class="hint">Resurrecting sends it to ${esc(buddyName())} for a second opinion.</p></section>` : ""}
  <div class="filters" role="group" aria-label="Filter by category">${["All",...CATS].map(c => `<button type="button" data-act="filter" data-id="${c}" aria-pressed="${gFilter===c}">${c}</button>`).join("")}</div>
  ${list.length ? `<div class="obits">${list.map(i => `<article class="obit"><span class="eyebrow">Here lies</span>
      <div class="obit-h"><h3>${esc(i.name)}</h3><span class="pr num">${money(i.price)}</span></div>
      <p class="obit-meta">${esc(i.cat)} · Wanted ${fmt(i.createdAt)} · Let go ${fmt(i.decidedAt)}${i.example ? " · Example" : ""}</p>
      <p class="reason">${i.forgotten ? "Forgotten for good." : graveLine(i).replace(/^./, c => c.toUpperCase()) + "."} Last words: "${esc(i.reason)}"</p></article>`).join("")}</div>`
   : `<section class="card quiet" style="align-items:center;text-align:center">${candle(44)}<p style="font-family:var(--display);font-style:italic;font-size:20px">Nothing buried${gFilter==="All" ? " yet" : " in " + gFilter.toLowerCase()}.</p>
      <p class="hint">When you let something go, its tombstone shows up here.</p><a class="btn small" href="#ask">I want something</a></section>`}`;
}
function graveLine(i){
  if (i.forgotten) return "forgotten forever";
  const d = Math.round((i.decidedAt - i.createdAt)/D);
  return d <= 0 ? "let go the same day" : "let go after " + plural(d,"day");
}

function vChallenges(){
  if (!S.startedAt) return vWelcome();
  const c = S.challenge && chal(S.challenge.id), won = S.history.filter(h => h.result === "won");
  const best = S.best||0;
  return `
    <div class="page-title"><span class="script">Themed months and weeks</span><h1><em>Challenges</em></h1></div>
  ${c ? `<section class="card wash"><span class="eyebrow">In progress</span><h2 style="font-size:26px">${esc(c.name)}</h2><p class="muted">${esc(c.blurb)}</p>
    <div class="bar"><i style="width:${Math.round(daysBetween(S.challenge.start,today())/c.days*100)}%"></i></div>
    <div class="between"><span class="hint">Day ${daysBetween(S.challenge.start,today())} of ${c.days}</span><button class="link" data-act="quit">Give up</button></div>
    <p class="hint">${c.cats ? "Buying " + c.cats.join(" or ").toLowerCase() + " ends it." : "Any impulse buy ends it."} Your monthly freeze protects it.</p></section>` : ""}
  <section class="card quiet">${CHALLENGES.map(x => `<div class="chal"><div class="stack" style="gap:2px"><h3>${esc(x.name)}</h3><span class="hint">${esc(x.blurb)} · ${x.days} days</span></div>
    ${S.challenge ? (S.challenge.id === x.id ? `<span class="chip go">Active</span>` : `<span class="chip">${won.some(w => w.id===x.id) ? "Won" : "—"}</span>`) : `<button class="btn small" data-act="start" data-id="${x.id}">Start</button>`}</div>`).join("")}</section>
  <section class="stack">
    <div class="section-h"><h2>Streak badges</h2><span class="eyebrow">Best ${best}</span></div>
    <div class="badges">${[7,30,90].map(n => `<div class="badge ${best>=n?"on":""}"><strong>${n}</strong><span>${best>=n ? "nights · earned" : "nights"}</span></div>`).join("")}</div>
  </section>
  ${S.history.length ? `<section class="card quiet"><span class="eyebrow">History</span>${S.history.slice().reverse().map(h => `<div class="between"><span>${esc((chal(h.id)||{}).name||h.id)}</span><span class="chip ${h.result==="won"?"go":""}">${h.result==="won" ? "Won " + fmtDay(h.end) : "Ended " + fmtDay(h.end)}</span></div>`).join("")}</section>` : ""}`;
}

function vSetup(){
  if (wiz && wiz.edit) return vWizard();
  return `
    <div class="row"><button class="link" data-act="go" data-id="home">${icon.back} Back</button></div>
  <div class="page-title"><span class="script">Preferences</span><h1><em>Settings</em></h1></div>
  ${S.startedAt ? profileCard(S.profile||{}, S.settings) + `<button class="btn" data-act="editProfile" style="align-self:flex-start">Edit my profile</button>` : ""}
  <h2 style="font-size:24px;margin-top:8px">Quick settings</h2>
  <form class="card" data-form="setup">${setupFields()}<button class="btn primary" type="submit">Save</button></form>
  <section class="card quiet">
    <span class="eyebrow">Your data</span>
    <p class="hint" style="font-size:14px">${mode === "cloud" ? "Saved to your account. Only you can see it, on any device you open this on." : "Saved on this device only."}</p>
    ${S.items.some(i => i.example) ? `<button class="btn small" data-act="clearExamples">Remove example data</button>` : ""}
    <button class="btn small" data-act="resetAsk">Start over</button>
  </section>
  <p class="hint" style="text-align:center">If shopping ever feels out of your control, talking it through with a counselor really helps.</p>`;
}

/* ---------- create your profile ---------- */
const REASONS = ["Save money","Less clutter","Stop stress shopping","Pay off a card","Save for something big","Just curious"];
const WEAK = ["Makeup","Skincare","Clothes","Shoes","Bags","Home decor","Candles","Tech","Books","Takeout","Amazon finds","Collectibles"];
const PLACES = ["TikTok Shop","Instagram ads","Amazon","Sephora","Ulta","Target","Shein","Thrift stores","Outlet malls"];
const TIMES = ["Late at night","Payday","When stressed","When bored","After a bad day","During sales","Weekends"];
const TRIGGERS = ["Scrolling","Influencers","Sale emails","“Only 2 left”","Friends’ hauls","Free shipping minimums","New drops"];
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const TONES = [
  {v:"gentle", t:"Gentle", d:"Warm and encouraging. Soft questions, no pressure."},
  {v:"honest", t:"Straight-up honest", d:"Calm and direct. Says what it sees."},
  {v:"tough",  t:"Tough love", d:"Firm. Holds you to your own goals, without being harsh."}
];
const STEP_NAMES = ["About you","Your why","Your weak spots","Your budget","Your safe person","Your style","Your profile"];
const STEP_TITLES = ["Let’s start with <em>you</em>.","Why are you <em>here</em>?","Where it <em>gets you</em>.","Your <em>budget</em>.","Your <em>safe person</em>.","How should we <em>talk</em> to you?","Meet <em>you</em>."];
const DEFAULT_MSG = "Hey {buddy}, can I buy “{item}” for {price}? My reason: “{reason}”. Reply YES, NO, or WAIT A WEEK.";
let wiz = null;

function startWizard(edit){
  const P = S.profile || {}, st = S.settings;
  wiz = {step: edit ? 0 : 0, edit: !!edit, d: Object.assign({
    name:"", birthMonth:"", reasons:[], stopWhat:"", because:"", weak:[], weakOther:"", places:[], times:[], triggers:[],
    monthlyFun:150, longerWait:true, buddyHow:"Text", buddyRel:"Best friend", buddyMsg:DEFAULT_MSG, tone:"honest", nudge:"soft"
  }, P, {buddy:st.buddy, limit:st.limit, waitHours:st.waitHours, goalName:st.goalName, goalAmount:st.goalAmount})};
}
const chipset = (name, opts, sel, label) => `<div class="chipset" role="group" aria-label="${esc(label)}">${opts.map((o,n) =>
  `<label for="w-${name}-${n}"><input id="w-${name}-${n}" type="checkbox" name="${name}" value="${esc(o)}" ${(sel||[]).includes(o) ? "checked" : ""}><span>${esc(o)}</span></label>`).join("")}</div>`;
const listText = arr => { arr = (arr||[]).filter(Boolean); return arr.length <= 1 ? (arr[0]||"") : arr.slice(0,-1).join(", ") + " and " + arr[arr.length-1]; };
const initials = n => (String(n||"").trim().split(/\s+/).map(w => w[0]).join("").slice(0,2) || "·").toUpperCase();
const allWeak = P => [...(P.weak||[]), ...(P.weakOther ? P.weakOther.split(",").map(x => x.trim()).filter(Boolean) : [])];

function profileCard(P, st){
  const weak = allWeak(P).map(x => x.toLowerCase());
  const rows = [
    weak.length ? ["Weak spots", listText(weak)] : null,
    (P.times||[]).length ? ["Risky times", listText(P.times.map(x => x.toLowerCase()))] : null,
    (P.triggers||[]).length ? ["Triggers", listText(P.triggers.map(x => x.toLowerCase()))] : null,
    (P.places||[]).length ? ["Usually shops", listText(P.places)] : null,
    st.goalName ? ["Saving for", esc(st.goalName) + (Number(st.goalAmount) ? " · " + money(st.goalAmount) : "")] : null,
    Number(P.monthlyFun) ? ["Fun money", money(P.monthlyFun) + " a month"] : null,
    st.buddy ? ["Safe person", esc(st.buddy) + (P.buddyRel ? ", " + esc(P.buddyRel.toLowerCase()) : "") + (P.buddyHow ? " · via " + esc(P.buddyHow.toLowerCase()) : "")] : null,
    ["Asks first over", money(st.limit)],
    ["Coach tone", esc((TONES.find(t => t.v === P.tone) || TONES[1]).t)]
  ].filter(Boolean);
  return `<section class="card pcard">
    <div class="p-top"><div class="avatar" aria-hidden="true">${esc(initials(P.name))}</div>
      <div class="stack" style="gap:2px;min-width:0"><span class="eyebrow">Profile</span><h2 style="font-size:30px;font-style:italic;overflow-wrap:anywhere">${esc(P.name || "You")}</h2>
      ${(P.reasons||[]).length ? `<span class="hint">Here to ${esc(listText(P.reasons).toLowerCase())}</span>` : ""}</div></div>
    ${P.stopWhat ? `<p class="pquote">“I want to stop buying ${esc(P.stopWhat)}${P.because ? " because " + esc(P.because) : ""}.”</p>` : ""}
    <dl class="plist">${rows.map(([k,v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join("")}</dl>
  </section>`;
}

function vWizard(){
  const st = wiz.step, d = wiz.d;
  const head = `<div class="page-title"><span class="script">${st < 6 ? `Step ${st+1} of 6 · ${STEP_NAMES[st]}` : wiz.edit ? "Updated profile" : "All set"}</span><h1>${STEP_TITLES[st]}</h1></div>
    <div class="bar" role="img" aria-label="Step ${Math.min(st+1,6)} of 6"><i style="width:${Math.round((st+1)/7*100)}%"></i></div>`;
  const nav = (next = "Next") => `<div class="between" style="margin-top:6px">${st > 0 ? `<button type="button" class="btn" data-act="wizBack">Back</button>` : (wiz.edit ? `<button type="button" class="btn" data-act="wizCancel">Cancel</button>` : "<span></span>")}<button class="btn primary" type="submit">${next}</button></div>`;
  let body = "";
  if (st === 0) body = `
    <label for="w-name">What should we call you?<input id="w-name" name="name" required maxlength="40" autocomplete="given-name" placeholder="Your first name or a nickname" value="${esc(d.name)}"></label>
    <label for="w-bm">Birthday month (optional)<select id="w-bm" name="birthMonth"><option value="">Prefer not to say</option>${MONTHS.map(m => `<option ${d.birthMonth===m?"selected":""}>${m}</option>`).join("")}</select>
      <span class="hint">We’ll remind you to plan your birthday treat instead of impulse buying it.</span></label>${nav()}`;
  if (st === 1) body = `
    <fieldset class="fs"><legend>What brings you here? <span class="hint">Pick any</span></legend>${chipset("reasons", REASONS, d.reasons, "Reasons")}</fieldset>
    <fieldset class="fs"><legend>In your own words</legend>
      <div class="sentence"><span>I want to stop buying</span><input id="w-stop" name="stopWhat" maxlength="60" placeholder="makeup I don’t need" value="${esc(d.stopWhat)}" aria-label="What you want to stop buying">
      <span>because</span><input id="w-because" name="because" maxlength="120" placeholder="I want to save for Chicago" value="${esc(d.because)}" aria-label="Why"></div>
      <span class="hint">We’ll show you this right before you buy something.</span></fieldset>
    <div class="grid2">
      <label for="w-goal">Saving for<input id="w-goal" name="goalName" maxlength="40" placeholder="e.g. A trip, a new apartment" value="${esc(d.goalName)}"></label>
      <label for="w-goalamt">Goal amount<input id="w-goalamt" name="goalAmount" type="number" inputmode="decimal" min="0" step="1" value="${esc(d.goalAmount)}"></label>
    </div>${nav()}`;
  if (st === 2) body = `
    <fieldset class="fs"><legend>What do you over-indulge in?</legend>${chipset("weak", WEAK, d.weak, "Weak spots")}
      <label for="w-other" style="margin-top:6px">Anything else?<input id="w-other" name="weakOther" maxlength="80" placeholder="e.g. Stanley cups, perfume" value="${esc(d.weakOther)}"></label></fieldset>
    <fieldset class="fs"><legend>Where do you usually shop?</legend>${chipset("places", PLACES, d.places, "Places")}</fieldset>
    <fieldset class="fs"><legend>When do urges hit?</legend>${chipset("times", TIMES, d.times, "Times")}</fieldset>
    <fieldset class="fs"><legend>What usually sets it off?</legend>${chipset("triggers", TRIGGERS, d.triggers, "Triggers")}</fieldset>${nav()}`;
  if (st === 3) body = `
    <label for="w-fun">Monthly fun money <span class="hint">What you’re okay spending on wants each month</span>
      <div class="range-row"><input id="w-fun" name="monthlyFun" type="range" min="0" max="1000" step="10" value="${esc(d.monthlyFun)}"><output id="w-fun-out" for="w-fun" class="num">${money(d.monthlyFun)}</output></div></label>
    <div class="grid2">
      <label for="w-limit">Ask my safe person over<input id="w-limit" name="limit" type="number" inputmode="decimal" min="0" step="1" value="${esc(d.limit)}"></label>
      <label for="w-wait">Waiting room<select id="w-wait" name="waitHours">${[24,48,72].map(h => `<option value="${h}" ${+d.waitHours===h?"selected":""}>${h} hours</option>`).join("")}</select></label>
    </div>
    <label for="w-longer" class="check"><input id="w-longer" type="checkbox" name="longerWait" ${d.longerWait ? "checked" : ""}> Add an extra day of waiting for my weak spots</label>${nav()}`;
  if (st === 4) body = `
    <div class="grid2">
      <label for="w-buddy">Their name<input id="w-buddy" name="buddy" maxlength="40" placeholder="e.g. Maya" value="${esc(d.buddy)}"></label>
      <label for="w-rel">They’re your<select id="w-rel" name="buddyRel">${["Best friend","Sibling","Partner","Roommate","Parent","Coworker","Other"].map(r => `<option ${d.buddyRel===r?"selected":""}>${r}</option>`).join("")}</select></label>
    </div>
    <label for="w-how">How you’ll reach them<select id="w-how" name="buddyHow">${["Text","Instagram DM","Snapchat","WhatsApp","Call","In person"].map(r => `<option ${d.buddyHow===r?"selected":""}>${r}</option>`).join("")}</select></label>
    <label for="w-msg">Your “check me” message<textarea id="w-msg" name="buddyMsg" maxlength="400">${esc(d.buddyMsg)}</textarea>
      <span class="hint">{item}, {price} and {reason} fill in automatically. {buddy} becomes their name.</span></label>${nav()}`;
  if (st === 5) body = `
    <fieldset class="fs"><legend>How should the coach talk to you?</legend><div class="opts">${TONES.map(t => `<label for="w-tone-${t.v}"><input id="w-tone-${t.v}" type="radio" name="tone" value="${t.v}" ${d.tone===t.v?"checked":""}><strong>${t.t}</strong><span class="hint">${t.d}</span></label>`).join("")}</div></fieldset>
    <fieldset class="fs"><legend>Reminders</legend><div class="opts two">${[["soft","Soft","Quiet nudges when something’s ready."],["firm","Firm","Clear reminders, no sugarcoating."]].map(([v,t,ds]) => `<label for="w-n-${v}"><input id="w-n-${v}" type="radio" name="nudge" value="${v}" ${d.nudge===v?"checked":""}><strong>${t}</strong><span class="hint">${ds}</span></label>`).join("")}</div></fieldset>${nav("See my profile")}`;
  if (st === 6) return `${head}
    ${profileCard(d, d)}
    <form class="stack" data-form="wiz">
      <button class="btn primary" type="submit">${wiz.edit ? "Save profile" : "Start my streak tonight"}</button>
      <button type="button" class="btn" data-act="wizBack">Go back and edit</button>
    </form>`;
  return `${head}<form class="card" data-form="wiz" novalidate>${body}</form>
    ${st === 0 && !wiz.edit ? `<p class="hint" style="text-align:center">Want to look around first? <button class="link" data-act="examples">Fill it with example data</button></p>
    <p class="hint" style="text-align:center">${mode === "cloud" ? "Your data saves to your account and only you can see it." : mode === "device" ? "Your data saves on this device." : ""}</p>` : ""}`;
}

function wizCollect(fd){
  const d = wiz.d, st = wiz.step, g = k => String(fd.get(k) ?? "").trim();
  if (st === 0){ if (!g("name")){ toast("Add a name so we know what to call you."); return false; } d.name = g("name"); d.birthMonth = g("birthMonth"); }
  if (st === 1){ d.reasons = fd.getAll("reasons"); d.stopWhat = g("stopWhat"); d.because = g("because"); d.goalName = g("goalName"); d.goalAmount = Math.max(0, Number(g("goalAmount"))||0); }
  if (st === 2){ d.weak = fd.getAll("weak"); d.weakOther = g("weakOther"); d.places = fd.getAll("places"); d.times = fd.getAll("times"); d.triggers = fd.getAll("triggers"); }
  if (st === 3){ d.monthlyFun = Number(g("monthlyFun"))||0; d.limit = Math.max(0, Number(g("limit"))||0); d.waitHours = Number(g("waitHours"))||24; d.longerWait = fd.get("longerWait") === "on"; }
  if (st === 4){ d.buddy = g("buddy"); d.buddyRel = g("buddyRel"); d.buddyHow = g("buddyHow"); d.buddyMsg = g("buddyMsg") || DEFAULT_MSG; }
  if (st === 5){ d.tone = g("tone") || "honest"; d.nudge = g("nudge") || "soft"; }
  return true;
}
function wizFinish(){
  const d = wiz.d, keys = ["name","birthMonth","reasons","stopWhat","because","weak","weakOther","places","times","triggers","monthlyFun","longerWait","buddyRel","buddyHow","buddyMsg","tone","nudge"];
  S.profile = {}; keys.forEach(k => S.profile[k] = d[k]);
  Object.assign(S.settings, {buddy:d.buddy, limit:Number(d.limit)||0, waitHours:Number(d.waitHours)||24, goalName:d.goalName, goalAmount:Number(d.goalAmount)||0});
  const first = !S.startedAt;
  if (first){ S.startedAt = today(); S.streakStart = today(); S.exampleMode = false; }
  wiz = null; save(); location.hash = "home"; render(); toast(first ? `Welcome, ${d.name}. Night one starts now.` : "Profile saved.");
}

/* how the profile shapes the rest of the site */
const CAT_WEAK = {Makeup:["Makeup","Skincare"], Clothes:["Clothes","Shoes","Bags"], Home:["Home decor","Candles"], Other:["Tech","Books","Takeout","Amazon finds","Collectibles"]};
const isWeakCat = cat => { const P = S.profile || {}; return (CAT_WEAK[cat]||[]).some(w => (P.weak||[]).includes(w)); };
const waitFor = d => (Number(S.settings.waitHours)||24) + ((S.profile||{}).longerWait && isWeakCat(d.cat) ? 24 : 0);
const lateRisk = () => { const h = new Date().getHours(); return ((S.profile||{}).times||[]).includes("Late at night") && (h >= 22 || h < 4); };
function spentThisMonth(){
  const m = monthKey();
  return S.slips.filter(s => s.date.slice(0,7) === m).reduce((a,s) => a + (Number(s.price)||0), 0)
    + S.items.filter(i => i.status === "bought" && i.planned && dayKey(i.decidedAt).slice(0,7) === m).reduce((a,i) => a + (Number(i.price)||0), 0);
}

/* ---------- screenshot reading ---------- */
function shotBlock(){
  const sh = ask.shot;
  return `<div class="shot">
    <label class="shot-drop" for="a-shot">
      <input id="a-shot" type="file" accept="image/png,image/jpeg,image/webp,image/gif" data-shot>
      ${sh && sh.url ? `<img class="shot-thumb" src="${sh.url}" alt="Your screenshot">` : `<span class="shot-ic" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="5" width="18" height="14" rx="3"/><circle cx="9" cy="10" r="1.6"/><path d="M21 15l-5-5-8 9"/></svg></span>`}
      <span class="stack" style="gap:2px;min-width:0">
        <strong>${sh && sh.busy ? "Reading your screenshot…" : sh && sh.found ? "Filled in from your screenshot" : "Upload a screenshot"}</strong>
        <span class="hint">${sh && sh.err ? `<span class="warn">${esc(sh.err)}</span>` : sh && sh.found ? `Check it over${sh.found.store ? " · spotted on " + esc(sh.found.store) : ""}. Tap to use a different one.` : "From TikTok, Instagram or any store. We’ll read the product and price."}</span>
      </span>
    </label>
  </div>`;
}
function grabAskForm(){
  const f = document.querySelector('form[data-form="ask"]'); if (!f) return;
  const fd = new FormData(f), g = k => String(fd.get(k) ?? "");
  ask.draft = Object.assign({}, ask.draft || {}, {name:g("name"), price:g("price"), url:g("url"), cat:g("cat") || "Makeup", reason:g("reason")});
}
async function readShot(file){
  if (!file || !sampleFn) return;
  grabAskForm();
  if (ask.shot && ask.shot.url) try { URL.revokeObjectURL(ask.shot.url); } catch(e){}
  ask.shot = {url:URL.createObjectURL(file), busy:true};
  render();
  const prompt = `This is a screenshot of something a person is tempted to buy, taken from TikTok, Instagram, a store's website or app, or similar. Identify the main product being sold.
Reply with only JSON in exactly this shape:
{"name": string, "price": number or null, "category": "Makeup" | "Clothes" | "Home" | "Other", "store": string or null}
- name: short product name with the brand if visible, at most 60 characters, plus the shade or color if shown.
- price: the current price in dollars as a plain number (use the sale price if both are shown), or null if no price is visible.
- category: Makeup covers makeup, skincare and beauty; Clothes covers clothing, shoes, bags and accessories; Home covers decor, candles, kitchen and furniture; everything else is Other.
- store: the shop or app name if visible, else null.
Example: {"name":"Rare Beauty Soft Pinch Liquid Blush in Hope","price":23,"category":"Makeup","store":"Sephora"}`;
  try {
    const r = await sampleFn.json(prompt, {images:file, modelTier:"default"});
    const d = ask.draft || {};
    const price = r && r.price != null && isFinite(Number(String(r.price).replace(/[^0-9.]/g,""))) ? Number(String(r.price).replace(/[^0-9.]/g,"")) : null;
    ask.draft = Object.assign({}, d, {
      name: (r && typeof r.name === "string" && r.name.trim()) ? r.name.trim().slice(0,60) : d.name,
      price: price != null ? price : d.price,
      cat: r && CATS.includes(r.category) ? r.category : (d.cat || "Makeup")
    });
    ask.shot.busy = false; ask.shot.found = {store: r && typeof r.store === "string" ? r.store.slice(0,40) : ""};
    if (price == null) ask.shot.err = "No price showed in that screenshot. Add it below.";
  } catch(e){
    const code = e && e.code; ask.shot.busy = false;
    if (["not_granted","sampling_disabled","not_declared","capability_disabled","capability_removed","images_unavailable"].includes(code)){ imgOK = false; ask.shot = null; toast("Screenshot reading isn't available here. Fill it in yourself."); }
    else if (code === "image_rejected") ask.shot.err = "That file didn't work. Try a PNG or JPG screenshot.";
    else if (code === "invalid_json" || code === "empty_completion") ask.shot.err = "Couldn't find a product in that screenshot. Fill it in yourself.";
    else if (code === "rate_limited") ask.shot.err = "Too many tries just now. Wait a moment and try again.";
    else if (code !== "cancelled") ask.shot.err = "Couldn't read that one. Try again, or fill it in yourself.";
  }
  render();
  const n = document.getElementById(ask.draft && ask.draft.reason ? "a-name" : "a-reason"); if (n) n.focus();
}
document.addEventListener("change", e => { if (e.target.matches && e.target.matches("[data-shot]")) readShot(e.target.files && e.target.files[0]); });

/* ---------- sheets ---------- */
function sheetHtml(){
  if (!sheet) return "";
  if (sheet.type === "slip"){
    const i = sheet.item || {};
    return `<div class="scrim" data-act="closeSheet"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sh-t" data-stop="1">
      <h2 id="sh-t" style="font-size:26px">Log a purchase</h2>
      <p class="muted">No shame here. Logging it honestly is how the pattern gets clearer.</p>
      <form class="stack" data-form="slip">
        <label for="s-name">What did you buy?<input id="s-name" name="name" required maxlength="60" value="${esc(i.name)}"></label>
        <div class="grid2"><label for="s-price">Price<input id="s-price" name="price" type="number" inputmode="decimal" min="0" step="0.01" required value="${esc(i.price)}"></label>
        <label for="s-cat">Category<select id="s-cat" name="cat">${CATS.map(c => `<option ${ (i.cat||"Makeup")===c?"selected":""}>${c}</option>`).join("")}</select></label></div>
        ${freezeLeft() ? `<label style="flex-direction:row;align-items:center;gap:10px;text-transform:none;letter-spacing:normal;font-size:15px;color:var(--ink);font-weight:400"><input type="checkbox" name="freeze" style="width:22px;min-height:22px"> Use my monthly freeze to keep my streak</label>`
          : `<p class="hint">You've used this month's freeze, so your streak starts over tonight.</p>`}
        <button class="btn primary" type="submit">Log it</button>
        <button class="btn" type="button" data-act="closeSheet">Cancel</button>
      </form></div></div>`;
  }
  if (sheet.type === "confirmReset"){
    return `<div class="scrim" data-act="closeSheet"><div class="sheet" role="dialog" aria-modal="true" aria-labelledby="sh-t" data-stop="1">
      <h2 id="sh-t" style="font-size:24px">Erase everything?</h2><p class="muted">Your streak, graveyard, challenges and settings will be deleted. This can't be undone.</p>
      <button class="btn primary" data-act="doReset">Erase and start over</button><button class="btn" data-act="closeSheet">Keep my data</button></div></div>`;
  }
  return "";
}

/* ---------- render ---------- */
function closeMenu(){ const sd = document.getElementById("side"); if (!sd) return; sd.classList.remove("open"); const sc = document.getElementById("navscrim"); if (sc) sc.hidden = true; const mb = document.querySelector('[data-act="menu"]'); if (mb) mb.setAttribute("aria-expanded","false"); }
function render(){
  const v = ["home","ask","challenges","graveyard","setup"].includes(view) ? view : "home";
  housekeeping();
  document.body.dataset.view = (!S.startedAt && ["home","ask","challenges"].includes(v)) ? "welcome" : v;
  const sf = document.getElementById("sideFoot");
  if (sf) sf.innerHTML = S.startedAt ? `<span class="eyebrow">${esc((S.profile||{}).name || "Streak")}</span><strong class="num">${streak()}</strong><span class="hint">${streak() === 1 ? "night" : "nights"} · ${money(fund())} kept</span>` : `<span class="eyebrow">Welcome</span><span class="hint">Set up your streak to begin.</span>`;
  closeMenu();
  const html = mode === "loading" ? `<div class="welcome"><div class="word"><span class="script">Here</span><b>Lies</b></div></div>`
    : v === "home" ? vHome() : v === "ask" ? vAsk() : v === "challenges" ? vChallenges() : v === "graveyard" ? vGraveyard() : vSetup();
  document.getElementById("app").innerHTML = html;
  document.getElementById("layer").innerHTML = sheetHtml();
  document.querySelectorAll(".side nav a").forEach(a => { if (a.dataset.tab === v) a.setAttribute("aria-current","page"); else a.removeAttribute("aria-current"); });
  const chat = document.getElementById("chat"); if (chat) chat.scrollTop = chat.scrollHeight;
}
function renderChat(){ const el = document.getElementById("chat"); if (el){ el.innerHTML = chatHtml(); el.scrollTop = el.scrollHeight; } }

let toastT;
function toast(msg){
  let t = document.querySelector(".toast"); if (!t){ t = document.createElement("div"); t.className = "toast"; t.setAttribute("role","status"); document.body.appendChild(t); }
  t.textContent = msg; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2800);
}

/* ---------- logic ---------- */
const routeFor = d => (Number(S.settings.limit) > 0 && Number(d.price) >= Number(S.settings.limit)) ? "buddy" : "waiting";
const buddyMsg = i => String((S.profile||{}).buddyMsg || "Hey {buddy}, can I buy \u201c{item}\u201d for {price}? My reason: \u201c{reason}\u201d. Reply YES, NO, or WAIT A WEEK.")
  .replaceAll("{buddy}", S.settings.buddy || "you").replaceAll("{item}", i.name).replaceAll("{price}", money(i.price)).replaceAll("{reason}", i.reason);
function findItem(id){ return S.items.find(i => i.id === id); }
function bury(i){ i.status = "buried"; i.decidedAt = Date.now(); save(); }
function logSlip({name, price, cat, freeze, itemId}){
  const t = today();
  S.slips.push({date:t, name, price:Number(price)||0, cat, freeze:!!freeze});
  if (freeze){ S.freezes[monthKey()] = 1; }
  else {
    S.streakStart = t;
    if (S.challenge){ const c = chal(S.challenge.id); if (c && (!c.cats || c.cats.includes(cat))){ S.history.push({id:c.id, start:S.challenge.start, end:t, result:"ended"}); S.challenge = null; } }
  }
  if (itemId){ const i = findItem(itemId); if (i){ i.status = "bought"; i.decidedAt = Date.now(); } }
  save();
}
function commitDraft(status){
  const d = ask.draft, now = Date.now();
  const i = {id:uid(), name:d.name, price:Number(d.price)||0, cat:d.cat, url:d.url||"", reason:d.reason, createdAt:now, status, aiVerdict:ask.chat && ask.chat.verdict || ""};
  if (status === "waiting") i.readyAt = now + waitFor(d)*H;
  if (status === "buried") i.decidedAt = now;
  S.items.push(i); save();
  if (ask.chat && ask.chat.ctl) ask.chat.ctl.abort();
  ask = {step:"done", draft:null, chat:null, lastId:i.id};
}

function coachContext(){
  const P = S.profile || {}, bits = [];
  const tone = {gentle:"Be warm and gentle; soften questions.", honest:"Be calm and direct.", tough:"Be firm and hold them to their own goals, but never harsh or insulting."}[P.tone] || "";
  if (P.name) bits.push(`Their name is ${P.name}.`);
  if (allWeak(P).length) bits.push(`They say they over-indulge in: ${allWeak(P).join(", ")}.`);
  if ((P.times||[]).length) bits.push(`Urges usually hit: ${P.times.join(", ")}.`);
  if ((P.triggers||[]).length) bits.push(`Common triggers: ${P.triggers.join(", ")}.`);
  if (P.stopWhat) bits.push(`In their words: "I want to stop buying ${P.stopWhat}${P.because ? " because " + P.because : ""}."`);
  if (S.settings.goalName) bits.push(`They are saving for ${S.settings.goalName}.`);
  if (Number(P.monthlyFun)) bits.push(`Monthly fun budget ${money(P.monthlyFun)}, ${money(spentThisMonth())} spent so far this month.`);
  bits.push(`Their local time right now is ${new Date().toLocaleTimeString([], {hour:"numeric", minute:"2-digit"})} on ${new Date().toLocaleDateString(undefined,{weekday:"long"})}.`);
  return `\nWhat they've told you about themselves (use it when it is relevant, for example the time of day or their own words, but never recite it back as a list): ${bits.join(" ")}\n${tone}`;
}
const COACH_RULES = d => `You help an adult think through an impulse purchase before they make it. Write like a calm, perceptive friend: plain, direct, grown-up. No jokes, puns, wordplay or cute phrasing. Never mention the app, reapers, graveyards, ghosts or mascots. No openers like "Quick question" or "Great answer", no exclamation marks, no emoji, no markdown. Never lecture or shame.

The person wants to buy: ${d.name} (${d.cat}) for ${money(d.price)}.
Their reason, in their words: "${d.reason}"
${coachContext()}

Ask exactly ONE short question per message (under 25 words, just the question), aimed at what is really driving the urge: whether they already own something similar, how they're feeling right now, what happens if they wait, whether they would buy it at full price next month. Ask at most three questions in total. After their third answer (or sooner if it's clearly decided), reply with one line that starts with "VERDICT:" followed by either "Bury it." or "Ask your buddy." or "Sounds planned." and one short sentence why.`;

async function coachTurn(){
  const ch = ask.chat, d = ask.draft;
  ch.busy = true; ch.live = ""; ch.err = ""; ch.ctl = new AbortController(); render();
  const asked = ch.turns.filter(t => t.role === "assistant").length;
  const input = [{role:"user", content: COACH_RULES(d) + (asked === 0 ? "\n\nAsk your first question now." : "")}, ...ch.turns];
  if (asked >= 3) input.push({role:"user", content:"That was my last answer. Give the VERDICT line now."});
  try {
    const {text} = await sampleFn(input, {modelTier:"quick", cache:false, signal:ch.ctl.signal, onText:({text}) => { ch.live = text.replace(/VERDICT:\s*/i,""); renderChat(); }});
    ch.live = null;
    const m = text.match(/VERDICT:\s*([\s\S]*)/i);
    if (m){ const before = text.slice(0, m.index).trim(); if (before) ch.turns.push({role:"assistant", content:before}); ch.verdict = m[1].trim(); ch.done = true; }
    else ch.turns.push({role:"assistant", content:text.trim()});
  } catch(e){
    ch.live = null;
    const code = e && e.code;
    if (code === "cancelled"){ if (e.text) ch.turns.push({role:"assistant", content:e.text}); }
    else if (["not_granted","sampling_disabled","not_declared","capability_disabled","capability_removed"].includes(code)){ coachOff = true; ask.step = "decide"; ask.chat = null; ch.busy = false; render(); toast("The coach isn't available here. You can still send it on."); return; }
    else if (code === "rate_limited") ch.err = "The coach needs a breather. Try again in a bit, or skip it.";
    else if (code === "session_expired") ch.err = "Sign in again to use the coach.";
    else ch.err = "The coach got interrupted. Send your answer again, or skip it.";
  }
  ch.busy = false; ch.ctl = null; render();
  const inp = document.getElementById("c-in"); if (inp) inp.focus();
}

function seedExamples(){
  const now = Date.now(), t = today();
  S = fresh();
  Object.assign(S.settings, {buddy:"Maya", limit:60, waitHours:24, goalName:"Weekend trip", goalAmount:300});
  S.profile = {name:"Alex", reasons:["Save money","Stop stress shopping"], stopWhat:"makeup I already have dupes of", because:"I want that weekend trip", weak:["Makeup","Skincare","Candles"], weakOther:"", places:["TikTok Shop","Sephora"], times:["Late at night","Payday"], triggers:["Scrolling","Influencers"], monthlyFun:120, longerWait:true, buddyRel:"Best friend", buddyHow:"Text", buddyMsg:DEFAULT_MSG, tone:"honest", nudge:"soft"};
  S.startedAt = addDays(t,-45); S.streakStart = addDays(t,-12); S.best = 21; S.exampleMode = true;
  S.slips.push({date:addDays(t,-24), name:"Matte lipstick", price:22, cat:"Makeup", freeze:false, example:true});
  S.slips.push({date:addDays(t,-12), name:"Throw blanket", price:38, cat:"Home", freeze:false, example:true});
  S.slips.push({date:addDays(t,-5), name:"Lip liner", price:14, cat:"Makeup", freeze:true, example:true});
  S.freezes[monthKey()] = 1;
  const mk = (name, price, cat, reason, cAgo, dAgo, extra = {}) => Object.assign({id:uid(), name, price, cat, url:"", reason, createdAt:now - cAgo*D, decidedAt:dAgo == null ? undefined : now - dAgo*D, status:"buried", example:true}, extra);
  S.items.push(
    mk("24-shade palette",54,"Makeup","Everyone on my feed has it and it's 20% off",40,37),
    mk("Linen blazer",89,"Clothes","I need something for the interview, maybe",22,17),
    mk("Glossy lip trio",28,"Makeup","Limited edition, the pink one is so cute",15,14),
    mk("Velvet throw pillows",46,"Home","My couch looks boring",9,8),
    mk("Platform loafers",72,"Clothes","Saw them in a video and want them",5,3),
    mk("Brow gel",18,"Makeup","Mine is almost out, I think",1.2,null,{status:"waiting", readyAt:now - 2*H}),
    mk("Ceramic candle holder",34,"Home","It would look nice on my desk",0.8,null,{status:"waiting", readyAt:now + 5*H}),
    mk("Wool coat",140,"Clothes","Winter is coming and my coat is old",1,null,{status:"buddy"})
  );
  save();
}

/* ---------- events ---------- */
const actions = {
  go: id => { location.hash = id; },
  calPrev: () => { calOffset--; render(); },
  calNext: () => { calOffset = Math.min(0, calOffset + 1); render(); },
  wizBack: () => { if (!wiz) return; const f = document.querySelector('form[data-form="wiz"]'); if (f && wiz.step < 6) wizCollect(new FormData(f)); wiz.step = Math.max(0, wiz.step - 1); render(); window.scrollTo(0,0); },
  wizCancel: () => { wiz = null; render(); },
  editProfile: () => { startWizard(true); render(); window.scrollTo(0,0); },
  menu: () => { const sd = document.getElementById("side"); const open = !sd.classList.contains("open"); sd.classList.toggle("open", open); document.getElementById("navscrim").hidden = !open; document.querySelector('[data-act="menu"]').setAttribute("aria-expanded", String(open)); },
  menuClose: () => closeMenu(),
  slip: () => { sheet = {type:"slip"}; render(); setTimeout(() => document.getElementById("s-name")?.focus(), 30); },
  buy: id => { const i = findItem(id); sheet = {type:"slip", item:i}; render(); },
  bury: id => { const i = findItem(id); if (!i) return; bury(i); render(); ripOverlay(i); },
  approve: id => { const i = findItem(id); if (!i) return; i.status = "approved"; i.buddyVerdict = "yes"; save(); render(); },
  deny: id => { const i = findItem(id); if (!i) return; i.buddyVerdict = "no"; bury(i); render(); ripOverlay(i); },
  waitweek: id => { const i = findItem(id); if (!i) return; i.status = "waiting"; i.buddyVerdict = "wait"; i.readyAt = Date.now() + 7*D; save(); render(); toast("Back in the waiting room for a week."); },
  buyok: id => { const i = findItem(id); if (!i) return; i.status = "bought"; i.planned = true; i.decidedAt = Date.now(); save(); render(); toast("Planned purchase logged. Streak safe."); },
  copy: (id, btn) => {
    const i = findItem(id); if (!i) return; const txt = buddyMsg(i);
    const sel = () => { const el = document.getElementById("msg-" + id); if (el){ const r = document.createRange(); r.selectNodeContents(el); const s = getSelection(); s.removeAllRanges(); s.addRange(r); } toast("Selected. Copy it from here."); };
    try { navigator.clipboard.writeText(txt).then(() => toast("Copied. Send it to " + buddyName() + "."), sel); } catch(e){ sel(); }
  },
  claim: () => { const amt = Number(S.settings.goalAmount)||0; S.claimed = (S.claimed||0) + amt; S.claims.push({date:today(), amount:amt, name:S.settings.goalName}); save(); render(); toast("Enjoy it. That one was earned."); },
  examples: () => { seedExamples(); location.hash = "home"; render(); },
  clearExamples: () => {
    if (S.exampleMode){ S = fresh(); }
    else { S.items = S.items.filter(i => !i.example); S.slips = S.slips.filter(s => !s.example); }
    save(); location.hash = "home"; render(); toast("Example data removed.");
  },
  resetAsk: () => { sheet = {type:"confirmReset"}; render(); },
  doReset: () => { S = fresh(); sheet = null; ask = {step:"form", draft:null, chat:null, shot:null}; save(); location.hash = "home"; render(); },
  closeSheet: (id, el, e) => { if (el.classList.contains("scrim") && e.target !== el) return; sheet = null; render(); },
  filter: id => { gFilter = id; render(); },
  rip: id => { const i = findItem(id); if (!i) return; i.revisited = true; i.forgotten = true; save(); render(); toast("Forgotten for good."); },
  resurrect: id => { const i = findItem(id); if (!i) return; i.revisited = true; i.status = "buddy"; i.createdAt = Date.now(); save(); location.hash = "home"; render(); toast("It rises. Ask " + buddyName() + " first."); },
  start: id => { S.challenge = {id, start:today()}; save(); render(); toast(chal(id).name + " starts today."); },
  quit: () => { const c = chal(S.challenge.id); S.history.push({id:c.id, start:S.challenge.start, end:today(), result:"ended"}); S.challenge = null; save(); render(); },
  route: () => { commitDraft(routeFor(ask.draft)); render(); },
  buryDraft: () => { commitDraft("buried"); render(); const i = findItem(ask.lastId); if (i) ripOverlay(i); },
  editDraft: () => { ask.step = "form"; render(); },
  coach: () => { ask.chat = {turns:[], busy:false, done:false, verdict:"", live:null, err:""}; ask.step = "chat"; coachTurn(); },
  stop: () => { ask.chat && ask.chat.ctl && ask.chat.ctl.abort(); },
  skipCoach: () => { if (ask.chat && ask.chat.ctl) ask.chat.ctl.abort(); ask.chat = null; ask.step = "decide"; render(); }
};
const forms = {
  wiz: fd => { if (!wiz) return; if (wiz.step === 6){ wizFinish(); return; } if (!wizCollect(fd)) return; wiz.step++; render(); window.scrollTo(0,0); },
  setup: fd => {
    const st = S.settings;
    st.buddy = String(fd.get("buddy")||"").trim(); st.limit = Math.max(0, Number(fd.get("limit"))||0);
    st.waitHours = Number(fd.get("waitHours"))||24; st.goalName = String(fd.get("goalName")||"").trim(); st.goalAmount = Math.max(0, Number(fd.get("goalAmount"))||0);
    const first = !S.startedAt;
    if (first){ S.startedAt = today(); S.streakStart = today(); }
    save(); toast(first ? "Your streak starts tonight." : "Saved."); location.hash = "home"; render();
  },
  ask: fd => {
    const reason = String(fd.get("reason")||"").trim();
    if (reason.length < 15){ toast("Give it a real reason, at least 15 characters."); return; }
    ask.draft = {name:String(fd.get("name")).trim(), price:Number(fd.get("price"))||0, url:String(fd.get("url")||"").trim(), cat:String(fd.get("cat")||"Other"), reason};
    ask.step = "decide"; render(); window.scrollTo(0,0);
  },
  slip: fd => {
    logSlip({name:String(fd.get("name")).trim(), price:fd.get("price"), cat:String(fd.get("cat")), freeze:fd.get("freeze") === "on", itemId:sheet && sheet.item && sheet.item.id});
    const froze = fd.get("freeze") === "on"; sheet = null; render(); toast(froze ? "Logged. Your freeze kept the streak alive." : "Logged. Tonight is night one again.");
  },
  chat: fd => {
    const ch = ask.chat, m = String(fd.get("msg")||"").trim(); if (!m || !ch || ch.busy) return;
    ch.turns.push({role:"user", content:m}); coachTurn();
  }
};
document.addEventListener("click", e => {
  const el = e.target.closest("[data-act]"); if (!el) return;
  if (el.classList.contains("scrim") && e.target.closest("[data-stop]")) return;
  const fn = actions[el.dataset.act]; if (fn){ if (el.tagName === "BUTTON") e.preventDefault(); fn(el.dataset.id, el, e); }
});
document.addEventListener("submit", e => { const f = e.target; if (!f.dataset.form) return; e.preventDefault(); forms[f.dataset.form] && forms[f.dataset.form](new FormData(f), f); });
document.addEventListener("keydown", e => { if (e.key === "Escape"){ closeMenu(); if (sheet){ sheet = null; render(); } } });

function onHash(){
  const h = (location.hash || "#home").slice(1);
  const next = ["home","ask","challenges","graveyard","setup"].includes(h) ? h : "home";
  if (next === "ask" && view !== "ask" && ask.step === "done") ask = {step:"form", draft:null, chat:null, shot:null};
  if (wiz && wiz.edit && next !== "setup") wiz = null;
  view = next; render(); window.scrollTo(0,0); if (view === "home") countUp();
}
window.addEventListener("hashchange", onHash);
document.addEventListener("input", e => { if (e.target.id === "w-fun"){ const o = document.getElementById("w-fun-out"); if (o) o.textContent = money(e.target.value); } });
setInterval(() => {
  if (view !== "home") return;
  let crossed = false;
  document.querySelectorAll("[data-ready]").forEach(el => { const ms = Number(el.dataset.ready) - Date.now(); if (ms <= 0) crossed = true; el.textContent = left(ms); });
  if (crossed && !document.activeElement?.matches("input,textarea,select") && !sheet) render();
}, 30000);
function countUp(){
  const el = document.getElementById("streakNum"); if (!el) return;
  const target = Number(el.textContent) || 0; if (!target || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const t0 = performance.now(), dur = 900;
  const step = t => { const p = Math.min(1, (t - t0)/dur); el.textContent = Math.round(target * (1 - Math.pow(1-p,3))); if (p < 1) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}

view = ["home","ask","challenges","graveyard","setup"].includes(location.hash.slice(1)) ? location.hash.slice(1) : "home";
render();
initStore();
})();
