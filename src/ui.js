// The DOM overlay: start screen, Esc menu, third-person HUD (year + speed), event captions,
// the logbook and a full-screen fog veil for the loop. Injected from JS with its CSS as a
// string; system fonts only.
//
//   initUI(opts)          once at boot. opts (all optional):
//                           onDrive()          Drive clicked (a user gesture: start audio here)
//                           onPause(paused)    Esc menu opened (true) / closed (false)
//                           onQuality(tier)    'low' | 'medium' | 'high' picked in the menu
//                           quality            initial tier to highlight (default 'high')
//                           start              show the start screen (default true; pass false
//                                              for ?script / ?pose captures)
//                           keys               install the Esc / L / Tab listener (default true)
//   updateUI()            every frame (dt from state.dt; or updateUI(dt)). Reads state (view, year, eraIdx, speed, found, loop),
//                         advances the caption and veil, and writes the DOM only when a
//                         shown value changes. Allocates nothing in steady state.
//   showEvent(id)         when an event is logged: caption fades in near the bottom for ~5 s.
//   setVeil(a)            veil opacity 0..1 now (e.g. setVeil(loopFog(state.clock)) per frame)
//   fadeVeil(to, sec, text)  animate the veil to `to` over `sec` s; optional line of text on it
//   openMenu(on), openLogbook(on), setQuality(tier), uiKey(code) -> consumed?
//   ui                    flags: started, paused (menu open), logbook (open), veil (0..1)

import { state } from './state.js';
import { EVENTS, ERA_NAMES, ERA_COUNT, eventEra, yearLabel, yearLabelIO, yearIO } from './world/time.js';

export const ui = { started: false, paused: false, logbook: false, veil: 0, card: false };

const CAPTION_SECONDS = 5.5; // fully visible time; fades add ~1 s each side
const SPEED_MAX = 400; // km/h strings precomputed up to this

const CSS = `
#jt{--u:clamp(9px,min(1.1vh,.64vw),24px);--serif:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif;
--sans:system-ui,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--ink:#f4ecdf;--dim:rgba(244,236,223,.66);
--amber:#e8b46a;--shadow:0 1px 2px rgba(10,7,4,.8),0 0 calc(var(--u)*.9) rgba(10,7,4,.75),0 0 calc(var(--u)*2.4) rgba(10,7,4,.55);
position:fixed;inset:0;pointer-events:none;z-index:10;color:var(--ink);font:calc(var(--u)*1.05)/1.45 var(--sans);
-webkit-font-smoothing:antialiased;user-select:none;-webkit-user-select:none}
#jt *{box-sizing:border-box}
#jt .sc{position:absolute;font:600 calc(var(--u)*.78)/1 var(--sans);letter-spacing:.18em;text-transform:uppercase}

/* HUD */
#jt .hud{position:absolute;inset:0;transition:opacity .6s}
#jt.pre .hud,#jt.fp .hud,#jt.over .hud{opacity:0}
#jt .corner{position:absolute;bottom:calc(var(--u)*3);text-shadow:var(--shadow)}
#jt .corner::before{content:"";position:absolute;inset:calc(var(--u)*-5) calc(var(--u)*-8);z-index:-1;
background:radial-gradient(closest-side,rgba(12,9,6,.55),rgba(12,9,6,.34) 55%,rgba(12,9,6,0));pointer-events:none}
#jt .when{left:calc(var(--u)*3.4)}
#jt .spd{right:calc(var(--u)*3.4);text-align:right}
#jt .lbl{display:block;font:600 calc(var(--u)*.72)/1 var(--sans);letter-spacing:.2em;text-transform:uppercase;color:var(--amber);margin-bottom:calc(var(--u)*.55)}
#jt .big{font:calc(var(--u)*2.3)/1.05 var(--serif);font-variant-numeric:lining-nums tabular-nums;letter-spacing:.005em}
#jt .unit{font:600 calc(var(--u)*.72)/1 var(--sans);letter-spacing:.16em;text-transform:uppercase;color:var(--dim);margin-left:calc(var(--u)*.45)}
#jt .hint{position:absolute;left:50%;top:calc(var(--u)*2.4);transform:translateX(-50%);font:calc(var(--u)*.9)/1 var(--sans);
color:rgba(244,236,223,.86);letter-spacing:.04em;transition:opacity 1.2s;opacity:0;white-space:nowrap;
padding:calc(var(--u)*.6) calc(var(--u)*1.2);border-radius:999px;background:rgba(14,10,7,.34);box-shadow:0 0 calc(var(--u)*2) rgba(14,10,7,.18)}
#jt .hint.on{opacity:1}
#jt .ap{position:absolute;right:calc(var(--u)*3.4);top:calc(var(--u)*2.4);display:flex;align-items:center;gap:calc(var(--u)*.6);
font:600 calc(var(--u)*.72)/1 var(--sans);letter-spacing:.2em;text-transform:uppercase;color:var(--dim);text-shadow:var(--shadow);
padding:calc(var(--u)*.5) calc(var(--u)*1);border-radius:999px;background:rgba(14,10,7,.3);transition:opacity .6s,color .3s}
#jt .ap kbd{font-size:.95em;letter-spacing:0}
#jt .ap i{width:.6em;height:.6em;border-radius:50%;border:1px solid rgba(244,236,223,.5);transition:background .3s,box-shadow .3s}
#jt .ap.on{color:var(--amber)}#jt .ap.on i{background:var(--amber);border-color:var(--amber);box-shadow:0 0 calc(var(--u)*.6) rgba(232,180,106,.8)}
#jt.pre .ap,#jt.over .ap{opacity:0}
#jt kbd{display:inline-block;min-width:1.9em;padding:.28em .45em .24em;border:1px solid rgba(244,236,223,.38);border-bottom-width:2px;
border-radius:.35em;font:600 .82em/1 var(--sans);text-align:center;color:var(--ink);background:rgba(244,236,223,.06);letter-spacing:.02em}

/* caption */
#jt .cap{position:absolute;left:50%;bottom:calc(var(--u)*9.5);width:min(calc(var(--u)*62),74vw);transform:translate(-50%,calc(var(--u)*.8));
text-align:center;opacity:0;transition:opacity 1.1s ease,transform 1.4s ease;text-shadow:var(--shadow)}
#jt .cap::before{content:"";position:absolute;inset:calc(var(--u)*-5) calc(var(--u)*-12);z-index:-1;
background:radial-gradient(closest-side,rgba(12,9,6,.68),rgba(12,9,6,.46) 55%,rgba(12,9,6,0))}
#jt .cap.on{opacity:1;transform:translate(-50%,0);transition:opacity .9s ease,transform 1.2s cubic-bezier(.2,.7,.2,1)}
#jt.over .cap{opacity:0}
#jt.fp .cap{left:calc(var(--u)*3.4);bottom:calc(var(--u)*3.4);width:min(calc(var(--u)*44),36vw);text-align:left;transform:translate(0,calc(var(--u)*.8))}
#jt.fp .cap.on{transform:none}
#jt.fp .cap .eb{justify-content:flex-start}#jt.fp .cap .eb::before{display:none}
#jt.fp .cap .nm{font-size:calc(var(--u)*2.6)}#jt.fp .cap .tx{font-size:calc(var(--u)*1.8)}
#jt .cap .eb{display:flex;align-items:center;justify-content:center;gap:calc(var(--u)*.9);font:600 calc(var(--u)*.74)/1 var(--sans);
letter-spacing:.22em;text-transform:uppercase;color:var(--amber)}
#jt .cap .eb::before,#jt .cap .eb::after{content:"";width:calc(var(--u)*3.2);height:1px;background:linear-gradient(90deg,transparent,rgba(232,180,106,.8))}
#jt .cap .eb::after{transform:scaleX(-1)}
#jt .cap .nm{font:calc(var(--u)*3.2)/1.1 var(--serif);margin:calc(var(--u)*.7) 0 calc(var(--u)*.5);letter-spacing:.005em}
#jt .cap .tx{font:calc(var(--u)*2.2)/1.32 var(--serif);color:rgba(246,239,228,.96);text-wrap:balance}

/* screens */
#jt .scr{position:absolute;inset:0;opacity:0;visibility:hidden;transition:opacity .5s,visibility 0s .5s}
#jt .scr.on{opacity:1;visibility:visible;pointer-events:auto;transition:opacity .5s}
#jt button{font:inherit;color:inherit;cursor:pointer;border:0;background:none;padding:0}
#jt button:focus-visible{outline:1.5px solid rgba(232,180,106,.7);outline-offset:3px}
#jt .ctl{display:grid;grid-template-columns:auto 1fr;gap:calc(var(--u)*.7) calc(var(--u)*1.4);align-items:center;font-size:calc(var(--u)*.98)}
#jt .ctl dt{display:flex;gap:.3em;justify-self:start}
#jt .ctl dd{margin:0;color:var(--dim)}
#jt .btn{display:inline-flex;align-items:center;gap:calc(var(--u)*.9);padding:calc(var(--u)*.95) calc(var(--u)*2.2);border-radius:999px;
background:var(--ink);color:#231b12;font:600 calc(var(--u)*1.05)/1 var(--sans);letter-spacing:.06em;
box-shadow:0 calc(var(--u)*.3) calc(var(--u)*1.6) rgba(0,0,0,.35);transition:background .2s,transform .2s}
#jt .btn:hover{background:#fff;transform:translateY(-1px)}
#jt .btn svg{width:1.1em;height:1.1em}

/* start */
#jt .start{background:linear-gradient(90deg,rgba(14,10,7,.86) 0%,rgba(14,10,7,.7) 34%,rgba(14,10,7,.12) 72%,rgba(14,10,7,0) 100%),
linear-gradient(0deg,rgba(14,10,7,.5),rgba(14,10,7,0) 40%)}
#jt .start .col{position:absolute;left:calc(var(--u)*8);top:50%;transform:translateY(-50%);width:min(calc(var(--u)*46),60vw)}
#jt .start .kick{font:600 calc(var(--u)*.8)/1 var(--sans);letter-spacing:.26em;text-transform:uppercase;color:var(--amber)}
#jt .start h1{font:calc(var(--u)*6.4)/.98 var(--serif);margin:calc(var(--u)*1.3) 0 calc(var(--u)*1.6);letter-spacing:-.012em;font-weight:400}
#jt .start h1 i{font-style:italic;color:rgba(244,236,223,.86)}
#jt .start .prem{font:italic calc(var(--u)*1.5)/1.45 var(--serif);color:rgba(244,236,223,.86);margin:0 0 calc(var(--u)*2.6);max-width:30em}
#jt .tl{position:relative;display:flex;justify-content:space-between;font:600 calc(var(--u)*.68)/1 var(--sans);letter-spacing:.18em;
text-transform:uppercase;color:var(--dim);padding-top:calc(var(--u)*1.1);margin-bottom:calc(var(--u)*2.8)}
#jt .tl::before{content:"";position:absolute;left:0;right:0;top:0;height:1px;background:linear-gradient(90deg,rgba(232,180,106,.9),rgba(244,236,223,.25))}
#jt .tl span{position:relative}
#jt .tl span::before{content:"";position:absolute;left:0;top:calc(var(--u)*-1.1 - 3px);width:7px;height:7px;border-radius:50%;background:var(--amber);box-shadow:0 0 0 3px rgba(14,10,7,.7)}
#jt .tl span:last-child::before{left:auto;right:0;background:none;border:1px solid rgba(244,236,223,.6)}
#jt .start .row{display:flex;align-items:flex-start;gap:calc(var(--u)*4.4)}
#jt .start .ctl{min-width:calc(var(--u)*20)}

/* menu */
#jt .menu{background:rgba(10,8,6,.5);display:flex;align-items:center;justify-content:center}
#jt .card{width:min(calc(var(--u)*34),88vw);padding:calc(var(--u)*2.8) calc(var(--u)*3);border-radius:calc(var(--u)*1.1);
background:linear-gradient(180deg,rgba(30,24,18,.9),rgba(20,16,12,.92));border:1px solid rgba(244,236,223,.12);
box-shadow:0 calc(var(--u)*2) calc(var(--u)*6) rgba(0,0,0,.5)}
#jt .card h2{font:calc(var(--u)*2.6)/1.05 var(--serif);font-weight:400;margin:calc(var(--u)*.7) 0 calc(var(--u)*.4)}
#jt .card .my{font:italic calc(var(--u)*1.3)/1.3 var(--serif);color:var(--dim);margin-bottom:calc(var(--u)*2.2)}
#jt .card .ctl dd{color:rgba(244,236,223,.78)}
#jt .card .src{display:inline-block;margin-top:calc(var(--u)*1.6);font:500 calc(var(--u)*.95)/1.2 var(--sans);color:var(--dim);text-decoration:none;border-bottom:1px solid currentColor;padding-bottom:.15em;pointer-events:auto}
#jt .card .src:hover,#jt .card .src:focus-visible{color:#f4ecdf}
#jt .card .sec{font:600 calc(var(--u)*.7)/1 var(--sans);letter-spacing:.2em;text-transform:uppercase;color:var(--dim);
margin:calc(var(--u)*2.2) 0 calc(var(--u)*1);display:flex;align-items:center;gap:calc(var(--u)*.8)}
#jt .card .sec::after{content:"";flex:1;height:1px;background:rgba(244,236,223,.14)}
#jt .seg{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;padding:4px;border-radius:999px;background:rgba(244,236,223,.07);border:1px solid rgba(244,236,223,.1)}
#jt .seg button{padding:calc(var(--u)*.7) 0;border-radius:999px;font:600 calc(var(--u)*.9)/1 var(--sans);letter-spacing:.06em;color:var(--dim);transition:background .2s,color .2s}
#jt .seg button:hover{color:var(--ink)}
#jt .seg button.on{background:var(--ink);color:#231b12}
#jt .card .btn{width:100%;justify-content:center}

/* logbook */
#jt .log{background:rgba(10,8,6,.55);display:flex;align-items:center;justify-content:center}
#jt .page{position:relative;width:min(calc(var(--u)*80),92vw);max-height:86vh;display:flex;flex-direction:column;color:#2c241b;
padding:calc(var(--u)*3) calc(var(--u)*3.6) calc(var(--u)*2.2);border-radius:calc(var(--u)*.5);
background:radial-gradient(120% 90% at 20% 0%,#f6efdf,#ece1c9 60%,#e2d4b6),#efe5cf;
box-shadow:0 calc(var(--u)*2.4) calc(var(--u)*7) rgba(0,0,0,.55),inset 0 0 calc(var(--u)*5) rgba(120,90,50,.18)}
#jt .page::after{content:"";position:absolute;left:calc(var(--u)*1.6);top:0;bottom:0;width:1px;background:rgba(170,60,40,.28)}
@media (max-aspect-ratio:5/4){#jt .ents{column-count:2}}@media (max-aspect-ratio:3/4){#jt .ents{column-count:1}}
#jt .page header{display:flex;align-items:flex-end;justify-content:space-between;gap:calc(var(--u)*2);padding-bottom:calc(var(--u)*1.2);border-bottom:1.5px solid rgba(44,36,27,.75)}
#jt .page h2{font:calc(var(--u)*3)/1 var(--serif);font-weight:400;margin:0}
#jt .page h2 small{display:block;font:600 calc(var(--u)*.7)/1 var(--sans);letter-spacing:.24em;text-transform:uppercase;color:#9a4a2c;margin-bottom:calc(var(--u)*.8)}
#jt .page .tot{display:flex;gap:calc(var(--u)*2.4);text-align:right}
#jt .page .tot b{display:block;font:calc(var(--u)*1.9)/1 var(--serif);font-weight:400;font-variant-numeric:lining-nums}
#jt .page .tot span{font:600 calc(var(--u)*.64)/1 var(--sans);letter-spacing:.18em;text-transform:uppercase;color:#7a6a55}
#jt .ents{margin:0;padding:calc(var(--u)*.6) 0 0;overflow:auto;column-count:3;column-gap:calc(var(--u)*2.6)}
#jt .ents section{break-inside:avoid;margin-bottom:calc(var(--u)*.9)}
#jt .ents h3{margin:0;padding:calc(var(--u)*.9) 0 calc(var(--u)*.45);font:600 calc(var(--u)*.62)/1 var(--sans);letter-spacing:.2em;text-transform:uppercase;color:#9a4a2c;
border-bottom:1px solid rgba(154,74,44,.3);display:flex;justify-content:space-between}
#jt .ents h3 span{color:#7a6a55;letter-spacing:.12em}
#jt .ents ol{list-style:none;margin:0;padding:0}
#jt .ents li{display:grid;grid-template-columns:calc(var(--u)*2.1) 1fr;align-items:center;column-gap:calc(var(--u)*.7);height:calc(var(--u)*4.1);min-width:0;border-bottom:1px solid rgba(60,80,110,.16)}
#jt .ents .no{font:italic calc(var(--u)*.95)/1 var(--serif);color:#9a4a2c;font-variant-numeric:lining-nums}
#jt .ents .bd{min-width:0}
#jt .ents .t{display:flex;align-items:baseline;gap:calc(var(--u)*.8);white-space:nowrap}
#jt .ents .nm{font:calc(var(--u)*1.2)/1.15 var(--serif);overflow:hidden;text-overflow:ellipsis}
#jt .ents .yr{font:600 calc(var(--u)*.62)/1 var(--sans);letter-spacing:.14em;text-transform:uppercase;color:#7a6a55;flex:none}
#jt .ents .cp{font:italic calc(var(--u)*.84)/1.3 var(--serif);color:#5a4c3c;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:calc(var(--u)*.2)}
#jt .ents li.un .nm{color:rgba(44,36,27,.4);font-style:italic}
#jt .ents li.un .cp{color:rgba(44,36,27,.38)}
#jt .page footer{display:flex;justify-content:space-between;padding-top:calc(var(--u)*1.3);border-top:1px solid rgba(44,36,27,.25);
font:calc(var(--u)*.82)/1 var(--sans);color:#7a6a55}
#jt .page kbd{color:#2c241b;border-color:rgba(44,36,27,.35);background:rgba(44,36,27,.05)}

/* witness: prompt, letterbox, big caption (camera.js drives it) */
#jt .wp{position:absolute;left:50%;bottom:calc(var(--u)*17);transform:translate(-50%,calc(var(--u)*.7));opacity:0;
transition:opacity .45s ease,transform .6s cubic-bezier(.2,.7,.2,1);display:flex;align-items:center;gap:calc(var(--u)*.9);
padding:calc(var(--u)*.55) calc(var(--u)*1.5) calc(var(--u)*.55) calc(var(--u)*.6);border-radius:999px;
background:rgba(18,13,9,.66);box-shadow:0 0 0 1px rgba(232,180,106,.42),0 calc(var(--u)*.3) calc(var(--u)*2.2) rgba(10,7,4,.4);
font:600 calc(var(--u)*.95)/1 var(--sans);letter-spacing:.2em;text-transform:uppercase;color:var(--ink);text-shadow:0 1px 2px rgba(10,7,4,.7)}
#jt .wp.on{opacity:1;transform:translate(-50%,0)}
#jt .wp kbd{min-width:2.1em;padding:.42em .5em .36em;font-size:1.05em;color:#231b12;background:var(--amber);border-color:#f2cf94;text-shadow:none;
animation:jtwp 2.4s ease-in-out infinite}
@keyframes jtwp{0%,100%{box-shadow:0 0 0 0 rgba(232,180,106,.55)}50%{box-shadow:0 0 0 calc(var(--u)*.45) rgba(232,180,106,0)}}
#jt .lb{position:absolute;left:0;right:0;height:11.5vh;background:#0f0c09;display:flex;align-items:center;justify-content:center;
transition:transform .9s cubic-bezier(.6,0,.25,1)}
#jt .lb.t{top:0;transform:translateY(-101%)}#jt .lb.b{bottom:0;transform:translateY(101%);height:auto;min-height:11.5vh;
padding:calc(var(--u)*1.3) calc(var(--u)*2) calc(var(--u)*1.7);box-sizing:border-box}
#jt.wit .lb{transform:none;transition:transform 1.1s cubic-bezier(.3,0,.2,1)}
#jt .lb>div{opacity:0;transition:opacity .5s ease;text-align:center}
#jt.wit .lb>div{opacity:1;transition:opacity 1.3s ease .9s}
#jt .wy{font:calc(var(--u)*2.9)/1 var(--serif);font-variant-numeric:lining-nums;letter-spacing:.06em;color:var(--amber)}
#jt .wy small{display:block;font:600 calc(var(--u)*.68)/1 var(--sans);letter-spacing:.3em;text-transform:uppercase;color:var(--dim);margin-bottom:calc(var(--u)*.7)}
#jt .wc .nm{font:calc(var(--u)*3.8)/1.05 var(--serif);letter-spacing:.005em}
/* the explanation: about twice its round-two size, upright, full ink, up to two balanced lines */
#jt .wc .tx{font:calc(var(--u)*2.45)/1.3 var(--serif);color:rgba(246,239,228,.96);margin:calc(var(--u)*.7) auto 0;
max-width:min(calc(var(--u)*60),88vw);text-wrap:balance}
#jt .wc .tx:empty{display:none}
#jt.wit .hud,#jt.wit .cap,#jt.wit .ap,#jt.wit .wp{opacity:0}

/* ending (src/ending.js): the takeover cue, the letterbox texts, the journey card */
#jt .ecue{position:absolute;left:50%;top:calc(var(--u)*2.4);transform:translate(-50%,calc(var(--u)*-.6));opacity:0;transition:opacity .9s,transform 1.1s;
display:flex;align-items:center;gap:calc(var(--u)*1.1);padding:calc(var(--u)*.6) calc(var(--u)*1.3);border-radius:999px;background:rgba(14,10,7,.42);
font:calc(var(--u)*.92)/1 var(--sans);letter-spacing:.04em;color:rgba(244,236,223,.9);white-space:nowrap;text-shadow:0 1px 2px rgba(10,7,4,.7)}
#jt .ecue.on{opacity:1;transform:translate(-50%,0)}
#jt .ecue i{width:.5em;height:.5em;border-radius:50%;background:var(--amber);box-shadow:0 0 calc(var(--u)*.6) rgba(232,180,106,.8)}
#jt .ecue span{color:var(--dim)}
#jt.end .hud,#jt.end .cap,#jt.end .ap,#jt.end .wp{opacity:0}
#jt.end .wc .nm{font-size:calc(var(--u)*2.6);font-style:italic;max-width:min(calc(var(--u)*64),88vw);margin:0 auto;line-height:1.3;text-wrap:balance}
#jt.end .wc .nm.ln{font-size:calc(var(--u)*3.1);font-style:normal}
#jt.end .lb>div{transition:opacity 1.6s ease .6s}
#jt .endc{background:linear-gradient(90deg,rgba(14,10,7,0) 30%,rgba(14,10,7,.5) 62%,rgba(14,10,7,.72))}
#jt .ecard{position:absolute;right:calc(var(--u)*7);top:50%;transform:translateY(-50%);width:min(calc(var(--u)*40),46vw);
padding:calc(var(--u)*2.8) calc(var(--u)*3);border-radius:calc(var(--u)*1.1);background:linear-gradient(180deg,rgba(30,24,18,.8),rgba(20,16,12,.86));
border:1px solid rgba(244,236,223,.12);box-shadow:0 calc(var(--u)*2) calc(var(--u)*6) rgba(0,0,0,.45)}
#jt .ecard h2{font:calc(var(--u)*3.4)/1 var(--serif);font-weight:400;margin:calc(var(--u)*.7) 0 calc(var(--u)*.5)}
#jt .ecard .my{font:italic calc(var(--u)*1.25)/1.35 var(--serif);color:var(--dim);margin-bottom:calc(var(--u)*1.8)}
#jt .route{display:flex;flex-wrap:wrap;align-items:center;gap:calc(var(--u)*.35);padding:calc(var(--u)*1) 0;border-top:1px solid rgba(244,236,223,.14);border-bottom:1px solid rgba(244,236,223,.14)}
#jt .route svg{width:calc(var(--u)*2.3);height:calc(var(--u)*1.65);fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
#jt .route .x{color:var(--dim);font:calc(var(--u)*1.1)/1 var(--serif);padding:0 .15em}
#jt .route .ar{color:rgba(244,236,223,.32);font-size:calc(var(--u)*.8)}
#jt .stats{display:grid;grid-template-columns:repeat(3,1fr);gap:calc(var(--u)*1.2);margin:calc(var(--u)*1.6) 0 calc(var(--u)*1.2)}
#jt .stats b{display:block;font:calc(var(--u)*1.9)/1 var(--serif);font-weight:400;font-variant-numeric:lining-nums;color:var(--ink)}
#jt .stats span{display:block;margin-top:calc(var(--u)*.45);font:600 calc(var(--u)*.62)/1.2 var(--sans);letter-spacing:.16em;text-transform:uppercase;color:var(--dim)}
#jt .evs{margin:0 0 calc(var(--u)*2);padding:0;list-style:none;columns:2;column-gap:calc(var(--u)*1.6);font:calc(var(--u)*.98)/1.5 var(--serif);color:rgba(244,236,223,.84)}
#jt .evs li{break-inside:avoid;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#jt .evs li::before{content:"";display:inline-block;width:.38em;height:.38em;border-radius:50%;background:var(--amber);margin:0 .6em .12em 0}
#jt .ecard .btn{width:100%;justify-content:center}
#jt .ecard .hk{margin-top:calc(var(--u)*.9);text-align:center;font:calc(var(--u)*.78)/1 var(--sans);color:var(--dim)}

/* veil */
#jt .veil{position:absolute;inset:0;opacity:0;background:radial-gradient(120% 90% at 50% 55%,#e9e6df 0%,#d6d2c8 55%,#b9b4a8 100%);
display:flex;align-items:center;justify-content:center}
#jt .veil div{font:italic calc(var(--u)*2.2)/1.3 var(--serif);color:rgba(48,42,34,.8);text-align:center;letter-spacing:.01em}
`;

const ARROW = '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10h12M11 5l5 5-5 5"/></svg>';
const k = (s) => `<kbd>${s}</kbd>`;
const CONTROLS =
  `<dl class="ctl">` +
  `<dt>${k('W')}${k('S')}</dt><dd>Throttle and brake</dd>` +
  `<dt>${k('A')}${k('D')}</dt><dd>Steer, and pick your turn</dd>` +
  `<dt>${k('P')}</dt><dd>Autopilot on or off</dd>` +
  `<dt>${k('E')}</dt><dd>Witness a moment in history</dd>` +
  `<dt>${k('C')}</dt><dd>Chase or driver's seat</dd>` +
  `<dt>${k('L')}</dt><dd>Logbook</dd>` +
  `<dt>${k('M')}</dt><dd>Mute</dd>` +
  `<dt>${k('Esc')}</dt><dd>Menu</dd>` +
  `</dl>`;

const HTML =
  `<div class="hud">` +
  `<div class="corner when"><span class="lbl"></span><span class="big yr"></span></div>` +
  `<div class="corner spd"><span class="lbl">Speed</span><span class="big kmh"></span><span class="unit">km/h</span></div>` +
  `<div class="hint">${k('P')}&ensp;autopilot&emsp;&emsp;${k('L')}&ensp;logbook&emsp;&emsp;${k('C')}&ensp;camera&emsp;&emsp;${k('Esc')}&ensp;menu</div>` +
  `</div>` +
  `<div class="ap">${k('P')}<span>Autopilot</span><i></i></div>` +
  `<div class="lb t"><div class="wy"><small>Witness</small><span></span></div></div>` +
  `<div class="lb b"><div class="wc"><div class="nm"></div><div class="tx"></div></div></div>` +
  `<div class="wp">${k('E')}<span>Witness</span></div>` +
  `<div class="cap"><div class="eb"></div><div class="nm"></div><div class="tx"></div></div>` +
  `<section class="scr start"><div class="col">` +
  `<div class="kick">A road trip through human history</div>` +
  `<h1>Journey<br><i>through</i> time</h1>` +
  `<p class="prem">Drive from the first humans to the present. The road runs through the centuries, and the turns you take decide what you witness.</p>` +
  `<div class="tl"><span>300,000 years ago</span><span>Today</span></div>` +
  `<div class="row"><button class="btn go">Drive ${ARROW}</button>${CONTROLS}</div>` +
  `</div></section>` +
  `<section class="scr menu"><div class="card">` +
  `<div class="lbl">Paused</div><h2 class="mt"></h2><div class="my"></div>` +
  `<button class="btn res">Resume ${ARROW}</button>` +
  `<div class="sec">Quality</div>` +
  `<div class="seg"><button data-q="low">Low</button><button data-q="medium">Medium</button><button data-q="high">High</button></div>` +
  `<div class="sec">Controls</div>${CONTROLS}` +
  `<a class="src" href="https://github.com/AvivK5498/journey-through-time" target="_blank" rel="noopener">Source code on GitHub \u2197</a>` +
  `</div></section>` +
  `<section class="scr log"><div class="page">` +
  `<header><h2><small>Travel log</small>Logbook</h2><div class="tot"><div><b class="nf"></b><span>Events found</span></div><div><b class="nj"></b><span>Journeys completed</span></div></div></header>` +
  `<div class="ents"></div>` +
  `<footer><span>Events are logged as you drive past them. Your log is kept from journey to journey.</span><span>${k('L')} close</span></footer>` +
  `</div></section>` +
  `<div class="ecue"><i></i>The car takes it from here<span>${k('Space')}&ensp;skip</span></div>` +
  `<section class="scr endc"><div class="ecard"><div class="lbl">Journey's end</div><h2>Home</h2><div class="my"></div>` +
  `<div class="route"></div><div class="stats"></div><ol class="evs"></ol>` +
  `<button class="btn keep">Keep driving ${ARROW}</button><div class="hk">or ${k('Enter')}</div></div></section>` +
  `<div class="veil"><div></div></div>`;

// ------------------------------------------------------------------ module state
let root = null, elYear, elEra, elKmh, elCap, elCapEb, elCapNm, elCapTx, elHint;
let elMenuYear, elStart, elMenu, elLog, elEnts, elNf, elNj, elVeil, elVeilText, elMenuTitle, segBtns;
let cb = {};
// Last shown values (ints / string refs) so the frame path only compares.
let shownView = -1, shownEra = -1, shownKmh = -1, shownYear = null, shownVeilQ = -1, shownOver = -1;
let logFound = -1, logLoop = -1;
let elAp = null, shownAp = -1; // autopilot indicator
// Doubles in a typed array (a module `let` holding a double is boxed on write).
const F = new Float64Array(5); // [0] caption timer, [1] veil level, [2] veil target, [3] veil rate/s, [4] hint timer
const KMH = new Array(SPEED_MAX + 1);
for (let i = 0; i <= SPEED_MAX; i++) KMH[i] = String(i);
const OPACITY = new Array(256);
for (let i = 0; i < 256; i++) OPACITY[i] = String(i / 255);
let CAP_EB = null; // built at init (the events table may grow)

const $ = (s) => root.querySelector(s);

export function initUI(opts = {}) {
  cb = opts;
  CAP_EB = EVENTS.map((e) => `Logged · ${e.yearText}`);
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  root = document.createElement('div');
  root.id = 'jt';
  root.innerHTML = HTML;
  document.body.appendChild(root);
  elYear = $('.yr'); elEra = $('.when .lbl'); elKmh = $('.kmh'); elHint = $('.hint'); elAp = $('.ap');
  elCap = $('.cap'); elCapEb = $('.cap .eb'); elCapNm = $('.cap .nm'); elCapTx = $('.cap .tx');
  elStart = $('.start'); elMenu = $('.menu'); elLog = $('.log'); elEnts = $('.ents'); elNf = $('.nf'); elNj = $('.nj');
  elVeil = $('.veil'); elVeilText = $('.veil div'); elMenuTitle = $('.mt'); elMenuYear = $('.my');
  segBtns = root.querySelectorAll('.seg button');
  segBtns.forEach((b) => b.addEventListener('click', () => {
    setQuality(b.dataset.q);
    if (cb.onQuality) cb.onQuality(b.dataset.q);
  }));
  $('.go').addEventListener('click', drive);
  $('.res').addEventListener('click', () => openMenu(false));
  $('.keep').addEventListener('click', () => { if (cb.onKeep) cb.onKeep(); });
  elLog.addEventListener('click', (e) => { if (e.target === elLog) openLogbook(false); });
  elMenu.addEventListener('click', (e) => { if (e.target === elMenu) openMenu(false); });
  setQuality(opts.quality || 'high');
  if (state.script || state.pose >= 0) elAp.style.display = 'none'; // captures: the scripted drive has no player autopilot
  if (opts.start !== false) { root.classList.add('pre'); elStart.classList.add('on'); }
  else ui.started = true;
  if (opts.keys !== false) addEventListener('keydown', onKey);
  syncOver();
  setVeil(0);
  updateUI(0);
}

function drive() {
  if (ui.started) return;
  ui.started = true;
  elStart.classList.remove('on');
  root.classList.remove('pre');
  F[4] = 9; elHint.classList.add('on');
  if (cb.onDrive) cb.onDrive();
}

// Handles Esc / L / Tab (and Enter or Space on the start screen). Returns true if consumed.
export function uiKey(code) {
  if (!ui.started) {
    if (code === 'Enter' || code === 'Space') { drive(); return true; }
    return false;
  }
  if (code === 'Escape') {
    if (ui.logbook) openLogbook(false); else openMenu(!ui.paused);
    return true;
  }
  if (code === 'KeyL' || code === 'Tab') {
    if (!ui.paused) openLogbook(!ui.logbook);
    return true;
  }
  return false;
}
function onKey(e) {
  if (e.code === 'Tab') e.preventDefault();
  if (e.repeat) return;
  if (uiKey(e.code) && e.code !== 'Space') e.preventDefault();
}

function syncOver() {
  const over = ui.paused || ui.logbook ? 1 : 0;
  if (over !== shownOver) { shownOver = over; root.classList.toggle('over', over === 1); }
}

export function openMenu(on) {
  if (!root || on === ui.paused || (on && !ui.started)) return;
  ui.paused = on;
  if (on && ui.logbook) { ui.logbook = false; elLog.classList.remove('on'); }
  if (on) { elMenuTitle.textContent = ERA_NAMES[state.eraIdx]; elMenuYear.textContent = yearLabel(state.year); }
  elMenu.classList.toggle('on', on);
  if (on) $('.res').focus({ preventScroll: true });
  syncOver();
  if (cb.onPause) cb.onPause(on);
}

export function openLogbook(on) {
  if (!root || on === ui.logbook) return;
  ui.logbook = on;
  if (on) renderLog();
  elLog.classList.toggle('on', on);
  syncOver();
}

export function setQuality(tier) {
  if (!root) return;
  segBtns.forEach((b) => b.classList.toggle('on', b.dataset.q === tier));
}

const pad2 = (n) => (n < 10 ? '0' + n : String(n));
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
// Entries grouped by era (an event belongs to the era its log window opens in); unseen ones
// are a numbered silhouette. Allocates (only when the logbook is opened or changes).
function renderLog() {
  logFound = state.found; logLoop = state.loop;
  let html = '', nf = 0;
  const n = EVENTS.length;
  for (let era = 0; era < ERA_COUNT; era++) {
    let rows = '', got = 0, tot = 0;
    for (let i = 0; i < n; i++) {
      if (eventEra(i) !== era) continue;
      const e = EVENTS[i];
      tot++;
      if (i < 32 && (state.found >>> i) & 1) {
        nf++; got++;
        rows += `<li><span class="no">${pad2(i + 1)}</span><div class="bd"><div class="t"><span class="nm">${esc(e.name)}</span><span class="yr">${esc(e.yearText)}</span></div><div class="cp">${esc(e.caption)}</div></div></li>`;
      } else {
        rows += `<li class="un"><span class="no">${pad2(i + 1)}</span><div class="bd"><div class="t"><span class="nm">?</span></div><div class="cp">Not yet witnessed</div></div></li>`;
      }
    }
    if (tot) html += `<section><h3>${esc(ERA_NAMES[era])}<span>${got} / ${tot}</span></h3><ol>${rows}</ol></section>`;
  }
  elEnts.innerHTML = html;
  elNf.textContent = nf + ' / ' + n;
  elNj.textContent = String(state.loop);
}

export function showEvent(id) {
  if (!root || id < 0 || id >= EVENTS.length) return;
  const e = EVENTS[id];
  elCapEb.textContent = CAP_EB[id];
  elCapNm.textContent = e.name;
  elCapTx.textContent = e.short || e.caption; // the camp: the line the ending echoes
  elCap.classList.remove('on');
  void elCap.offsetWidth; // restart the fade if a caption is already showing
  elCap.classList.add('on');
  F[0] = CAPTION_SECONDS;
}

// A short note in the top pill (world/crossing.js: boarding the ship). Replaces the key hint.
export function showNote(text, seconds = 5) {
  if (!root || !elHint) return;
  elHint.textContent = text;
  elHint.classList.add('on');
  F[4] = seconds;
}

// Witness (camera.js): the `E` prompt (call on change only), and the moment's letterbox with
// the year and a large caption (show at the press, hide when the camera starts back).
export const witnessUI = { prompt: false, on: false };
export function witnessPrompt(on) {
  witnessUI.prompt = on;
  if (root) root.querySelector('.wp').classList.toggle('on', on);
}
export function witnessShow(id) {
  if (!root || id < 0 || id >= EVENTS.length) return;
  const e = EVENTS[id];
  root.querySelector('.wy span').textContent = e.yearText;
  root.querySelector('.wc .nm').textContent = e.name;
  root.querySelector('.wc .tx').textContent = e.caption;
  witnessUI.on = true;
  root.classList.add('wit');
}
export function witnessHide() {
  witnessUI.on = false;
  if (root) root.classList.remove('wit');
}

// ------------------------------------------------------------------ the ending (src/ending.js)
// endingCue(on): the small "the car takes it from here" pill. endingBars(year, caption, line):
// the letterbox (year on top, caption below; line = the closing line style); endingBars(null)
// hides it. endingYear(label): the year on top (call on change only). endingCard(d) shows the
// journey card (d: route [[region, crossed], ...], found, total, years, km, names); null hides.
const GLYPH = [
  '<path d="M3 17h22M14 17V9M14 11l-4-3M14 10l5-3"/><path d="M5 7.5q9-6 18 0z" fill="currentColor"/>',
  '<path d="M14 3v14M7.5 6.2l13 7.6M20.5 6.2l-13 7.6M12 4.5l2 2 2-2M12 15.5l2-2 2 2"/>',
  '<circle cx="20" cy="6" r="2.4"/><path d="M2 16q6-7 12 0t12 0M2 18.5h24"/>',
  '<path d="M9 17v-3M9 3l-5 11h10zM19 17v-5"/><circle cx="19" cy="9" r="3.6"/>',
  '<circle cx="19" cy="7" r="3"/><path d="M2 17h24M6 17l1-5M10 17l-1-6M14 17l1-4M18 17l-1-5M22 17l1-4"/>',
  '<path d="M2 17l8-11 4 5 3-3 9 9z"/><path d="M8 8.8l2-2.8 1.6 2"/>',
  '<path d="M7 12h13M13 3v9M13 4l6 7h-6M3 16q2.5-2 5 0t5 0t5 0t5 0t5 0"/>',
];
const GCOL = ['#d29a48', '#9cc3ec', '#e08a5c', '#7dba73', '#dcc566', '#a7afcf', '#6dbbe6'];
export function endingCue(on) { if (root) root.querySelector('.ecue').classList.toggle('on', on); }
export function endingBars(year, caption, line) {
  if (!root) return;
  if (year === null) { root.classList.remove('wit'); return; }
  root.classList.add('end');
  root.querySelector('.wy small').textContent = 'Home';
  root.querySelector('.wy span').textContent = year;
  const nm = root.querySelector('.wc .nm');
  nm.textContent = caption; nm.classList.toggle('ln', !!line);
  root.querySelector('.wc .tx').textContent = '';
  root.classList.add('wit');
}
export function endingYear(label) { if (root) root.querySelector('.wy span').textContent = label; }
export function endingCard(d) {
  if (!root) return;
  const el = root.querySelector('.endc');
  if (!d) { el.classList.remove('on'); ui.card = false; return; }
  let r = '';
  d.route.forEach(([g, crossed], i) => {
    if (i) r += crossed ? '<span class="x" title="across the strait">≈</span>' : '<span class="ar">›</span>';
    r += `<svg viewBox="0 0 28 20" style="color:${GCOL[g]}" aria-label="${esc(['Savannah', 'Ice', 'River desert', 'Forest', 'Steppe', 'Mountains', 'Coast'][g])}">${GLYPH[g]}</svg>`;
  });
  root.querySelector('.route').innerHTML = r;
  root.querySelector('.ecard .my').textContent = d.line;
  root.querySelector('.stats').innerHTML = `<div><b>${d.found} / ${d.total}</b><span>Events witnessed</span></div><div><b>${d.years}</b><span>Years travelled</span></div><div><b>${d.km}</b><span>Distance driven</span></div>`;
  root.querySelector('.evs').innerHTML = d.names.map((n) => `<li>${esc(n)}</li>`).join('');
  el.classList.add('on');
  ui.card = true;
  root.querySelector('.keep').focus({ preventScroll: true });
}
export function endingDone() { if (root) { root.classList.remove('end', 'wit'); root.querySelector('.wy small').textContent = 'Witness'; } }

export function setVeil(a) {
  F[1] = a < 0 ? 0 : a > 1 ? 1 : a;
  F[2] = F[1]; F[3] = 0;
  writeVeil();
}

export function fadeVeil(to, seconds, text) {
  F[2] = to < 0 ? 0 : to > 1 ? 1 : to;
  F[3] = seconds > 0 ? Math.abs(F[2] - F[1]) / seconds : 1e9;
  if (text !== undefined && root) elVeilText.textContent = text;
}

function writeVeil() {
  ui.veil = F[1];
  if (!root) return;
  const q = Math.round(F[1] * 255);
  if (q !== shownVeilQ) {
    if ((q === 0) !== (shownVeilQ === 0) || shownVeilQ < 0) elVeil.style.visibility = q === 0 ? 'hidden' : 'visible';
    shownVeilQ = q;
    elVeil.style.opacity = OPACITY[q];
  }
}

// dt: seconds since the last call; omitted, state.dt (no double argument on the frame path).
export function updateUI(dtIn) {
  if (!root) return;
  const dt = dtIn === undefined ? state.dt : dtIn;
  const view = state.view;
  if (view !== shownView) { shownView = view; root.classList.toggle('fp', view === 1); }
  if (view === 0) {
    const era = state.eraIdx;
    if (era !== shownEra) { shownEra = era; elEra.textContent = ERA_NAMES[era]; }
    yearIO[0] = state.year;
    const y = yearLabelIO();
    if (y !== shownYear) { shownYear = y; elYear.textContent = y; }
    let v = Math.round(state.speed * 3.6);
    v = v < 0 ? 0 : v > SPEED_MAX ? SPEED_MAX : v;
    if (v !== shownKmh) { shownKmh = v; elKmh.textContent = KMH[v]; }
  }
  if (F[0] > 0) { F[0] -= dt; if (F[0] <= 0) elCap.classList.remove('on'); }
  if (F[4] > 0) { F[4] -= dt; if (F[4] <= 0) elHint.classList.remove('on'); }
  const ap = state.autopilot ? 1 : 0;
  if (ap !== shownAp) { shownAp = ap; elAp.classList.toggle('on', ap === 1); }
  if (F[1] !== F[2]) {
    const step = F[3] * dt;
    if (Math.abs(F[2] - F[1]) <= step) F[1] = F[2];
    else F[1] += F[2] > F[1] ? step : -step;
    writeVeil();
  }
  if (ui.logbook && (state.found !== logFound || state.loop !== logLoop)) renderLog();
}
