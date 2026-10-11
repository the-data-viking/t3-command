/* eslint-disable react-refresh/only-export-components -- Standalone review-page entrypoint. */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FLIGHT_KIT as KIT, flightCrew } from './art/flightdeck';
import { STYLES } from './art/palettes';
import { rasterize } from './art/render';
import type { Grid } from './art/sprites';
import './designlab.css';

type Config = { map: string; rooms: string; links: string; docks: string; density: string; focus: string; module: string };
const options: Record<keyof Config, [string, string][]> = {
  map: [['deck','Connected deck'],['spine','Modular spine'],['orbit','Orbital campus']],
  rooms: [['chambers','System chambers'],['court','Central commons'],['open','Open bridge']],
  links: [['physical','Walkable corridors'],['network','Transit diagram'],['quiet','Quiet / no links']],
  docks: [['edge','Shared utility rack'],['local','Attached station modules']],
  density: [['quiet','Ambient'],['balanced','Operational'],['full','Annotated']],
  focus: [['all','All projects'],['attention','Attention first']],
  module: [['power','Power modules'],['engine','Engine nodes'],['quarters','Sleeping quarters']],
};
const presets = [
  { name:'01 / The Night Vessel', tag:'One ship. Shared purpose.', desc:'A continuous hull and legible compartments. Projects feel like departments aboard one vessel.', trade:'Strong sense of place; a large fleet can make the hull sprawling.', config:{map:'deck',rooms:'chambers',links:'physical',docks:'edge',density:'balanced',focus:'all',module:'power'} },
  { name:'02 / The Service Spine', tag:'A station that can grow.', desc:'A central service corridor with plug-in project wings. Utility modules stay close to the work.', trade:'Predictable expansion; the long central axis can demand more panning.', config:{map:'spine',rooms:'court',links:'physical',docks:'local',density:'full',focus:'all',module:'power'} },
  { name:'03 / The Constellation', tag:'Relationships over corridors.', desc:'Independent project islands around a shared operations hub. Routes become a readable diagram.', trade:'Easy to scan relationships; less of the intimate, walkable ship fantasy.', config:{map:'orbit',rooms:'court',links:'network',docks:'local',density:'quiet',focus:'all',module:'power'} },
] satisfies {name:string;tag:string;desc:string;trade:string;config:Config}[];
const projects = [
  {name:'T3 COMMAND',branch:'art / station-design',color:'#58d6c7',crew:4,state:'WORKING',task:'Reworking the station layout',env:'mac-mini'},
  {name:'LIVING STONE',branch:'feat / expedition',color:'#b69aff',crew:5,state:'REVIEW',task:'Embark controls ready to inspect',env:'agent-01'},
  {name:'AI GATEWAY',branch:'fix / routing',color:'#efb365',crew:3,state:'BLOCKED',task:'Provider choice needs your input',env:'agent-02'},
  {name:'FLEET OPS',branch:'chore / runners',color:'#81a9ed',crew:2,state:'IDLE',task:'Runner checks complete',env:'agent-03'},
];
const sprite = (grid:Grid, team=0x58d6c7) => rasterize(grid,STYLES['flightdeck-nightshift'],{team,visor:0x46d6c2,screen:0x345d6a}).toDataURL();
const art = {console:sprite(KIT.CONSOLE),terminal:sprite(KIT.TERMINAL),files:sprite(KIT.FILES),comms:sprite(KIT.COMMS),bunk:sprite(KIT.BUNK_SLEEPER),floor:sprite(KIT.FLOOR),door:sprite(KIT.DOOR_H)};
const crews = projects.map(p=>sprite(flightCrew('round','standard'),parseInt(p.color.slice(1),16)));
function loadConfig():Config {
 const c={...presets[2].config}; const params=new URLSearchParams(location.search);
 for(const k of Object.keys(options) as (keyof Config)[]) {const v=params.get(k);if(options[k].some(o=>o[0]===v))c[k]=v!;}
 return c;
}
function Picture({src,x,y,w,h}:{src:string;x:number;y:number;w:number;h:number}) {return <image href={src} x={x} y={y} width={w} height={h} style={{imageRendering:'pixelated'}}/>;}
const roomPlans:Record<string,[string,number,number,number,number][]> = {
 chambers:[['TERMINAL',8,30,110,70],['FILES',126,30,110,70],['COMMS',244,30,108,70],['BRIDGE',8,108,228,90],['QUARTERS',244,108,108,90]],
 court:[['TERMINAL',8,30,100,75],['FILES',8,113,100,85],['COMMONS',116,30,128,168],['COMMS',252,30,100,75],['QUARTERS',252,113,100,85]],
 open:[['BRIDGE',8,30,344,111],['SYSTEMS',8,149,224,49],['QUARTERS',240,149,112,49]],
};
function Station({i,c,selected,onSelect}:{i:number;c:Config;selected:boolean;onSelect:()=>void}) {
 const p=projects[i]; const muted=c.focus==='attention' && !selected && !['REVIEW','BLOCKED'].includes(p.state);
 return <g className="station" role="button" tabIndex={0} aria-label={`Inspect ${p.name}`} onClick={onSelect} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onSelect();}}} opacity={muted?.45:1}>
  <rect x="0" y="0" width="360" height="240" rx={c.rooms==='open'?18:5} fill="#111e2b" stroke={selected?p.color:'#425463'} strokeWidth={selected?3:2}/>
  <path d="M16 0H85 M275 240H344" stroke={p.color} strokeWidth="4"/>
  <text x="12" y="19" fill={p.color} fontSize="12" fontWeight="700">{p.name}</text><text x="348" y="19" textAnchor="end" fill="#a7b8c5" fontSize="9">{p.state}</text>
  {roomPlans[c.rooms].map(([name,x,y,w,h])=><g key={name}>
   <rect x={x} y={y} width={w} height={h} fill="url(#deckTile)" stroke="#4d6273" strokeWidth="2"/>
   {c.density!=='quiet'&&<text x={x+7} y={y+13} fill="#9cacba" fontSize="8" letterSpacing="1">{name}</text>}
   {name==='QUARTERS'?<><Picture src={art.bunk} x={x+12} y={y+24} w={32} h={24}/><Picture src={art.bunk} x={x+58} y={y+24} w={32} h={24}/></>:name==='BRIDGE'||name==='COMMONS'?<>{[0,1,2].map(n=><g key={n}><Picture src={art.console} x={x+10+(c.rooms==='court'?0:n*67)} y={y+23+(c.rooms==='court'?n*44:0)} w={56} h={36}/></g>)}</>:<><Picture src={name==='FILES'?art.files:name==='COMMS'?art.comms:art.terminal} x={x+14} y={y+20} w={48} h={40}/></>}
     </g>)}
  {(c.rooms==='chambers'?[[55,98,0],[176,98,0],[290,98,0],[234,154,1]]:c.rooms==='court'?[[106,66,1],[106,153,1],[242,66,1],[242,153,1]]:[[62,139,0],[284,139,0]]).map(([x,y,vertical],n)=><g key={n} transform={`translate(${x} ${y}) ${vertical?'rotate(-90)':''}`}><rect x="0" y="0" width="16" height="12" fill="#283e4b"/><Picture src={art.door} x={0} y={4} w={16} h={4}/></g>)}
  {(c.rooms==='chambers'?[[76,61],[192,61],[303,61],[42,151],[109,151]]:c.rooms==='court'?[[70,62],[70,148],[310,62],[160,64],[160,108]]:[[45,75],[112,75],[179,75],[246,75],[292,161]]).slice(0,p.crew).map(([x,y],n)=><Picture key={n} src={crews[i]} x={x} y={y} w={24} h={33}/>)}
  <text x="12" y="218" fill="#c1d0dc" fontSize="10">{c.density==='full'?p.branch:`${p.crew} crew · ${p.env}`}</text>
  {c.density==='full'&&<text x="12" y="231" fill="#7f95a8" fontSize="9">{p.task}</text>}
 </g>;
}
const positions:Record<string,[number,number][]> = {deck:[[190,95],[650,95],[190,445],[650,445]],spine:[[105,65],[735,65],[105,465],[735,465]],orbit:[[95,65],[695,95],[105,495],[695,465]]};
function Scene({c,selected,onSelect,detail=false}:{c:Config;selected:number;onSelect:(i:number)=>void;detail?:boolean}) {
 const pos=positions[c.map];
 return <svg viewBox={detail?'0 0 620 440':'0 0 1200 850'} aria-label={detail?'Selected station room plan':`${options.map.find(o=>o[0]===c.map)?.[1]} mock`}>
 <defs><pattern id="deckTile" width="16" height="16" patternUnits="userSpaceOnUse"><image href={art.floor} width="16" height="16" opacity=".4"/><rect width="16" height="16" fill="#213649" opacity=".4"/></pattern><pattern id="stars" width="103" height="89" patternUnits="userSpaceOnUse"><circle cx="13" cy="25" r="1" fill="#33495d"/><circle cx="84" cy="67" r=".7" fill="#5c758b"/></pattern></defs>
 <rect width="1200" height="850" fill="#080f1b"/><rect width="1200" height="850" fill="url(#stars)"/>
 {detail?<g transform="translate(40 50) scale(1.5)"><Station i={selected} c={c} selected onSelect={()=>onSelect(selected)}/></g>:<>
 {c.map==='deck'&&<path d="M150 45H1035L1100 120V690L1035 740H150L95 675V120Z" fill="#121e2b" stroke="#536574" strokeWidth="3"/>}
 {c.map==='spine'&&<g><rect x="582" y="36" width="36" height="704" fill="#162e3d" stroke="#4e778d" strokeWidth="2"/>{[45,120,195,560,635,710].map(y=><g key={y}><path d={`M540 ${y}H660`} stroke="#6f8ca0" strokeWidth="3"/><rect x="485" y={y-18} width="50" height="36" fill="#152c43" stroke="#375a72"/><rect x="665" y={y-18} width="50" height="36" fill="#152c43" stroke="#375a72"/></g>)}</g>}
 {c.map==='orbit'&&<><ellipse cx="600" cy="407" rx="470" ry="325" stroke="#283c52" strokeDasharray="4 12" fill="none"/><ellipse cx="600" cy="407" rx="500" ry="355" stroke="#172b3f" fill="none"/></>}
 {c.links!=='quiet'&&pos.map(([x,y],i)=><path key={i} d={`M${x+(i%2===0?360:0)} ${y+120} H${i%2===0?Math.min(x+390,510):Math.max(x-30,690)} V${i<2?392:428} H${i%2===0?530:670}`} fill="none" stroke={c.links==='physical'?'#263e4d':projects[i].color} strokeWidth={c.links==='physical'?28:3} strokeDasharray={c.links==='network'?'7 6':undefined}/>)}
 {c.links==='physical'&&<path d="M600 185V585" stroke="#263e4d" strokeWidth="28"/>}
 <g><rect x="530" y="372" width="140" height="76" rx="12" fill="#152b3c" stroke="#7b97a9"/><text x="600" y="398" textAnchor="middle" fill="#dce9ee" fontSize="12" letterSpacing="2">OPERATIONS</text><text x="600" y="422" textAnchor="middle" fill="#71d5c6" fontSize="10">14 CREW / 4 BASES</text></g>
 {pos.map(([x,y],i)=><g key={i} transform={`translate(${x} ${y})`}><Station i={i} c={c} selected={selected===i} onSelect={()=>onSelect(i)}/></g>)}
 {projects.map((p,i)=>{const [x,y]=c.docks==='edge'?[70+i*275,774]:[pos[i][0]+93,pos[i][1]+260];return <g key={p.name} aria-label={`${p.env} ${c.module} module`}>
  {c.docks==='local'&&<g><path d={`M${x+87} ${y-20}V${y}`} stroke="#263e4d" strokeWidth="14"/><path d={`M${x+87} ${y-20}V${y}`} stroke={p.color} strokeWidth="2"/><rect x={x+77} y={y-23} width="20" height="5" fill={p.color}/></g>}
  <rect x={x} y={y} width="174" height="64" rx={c.module==='engine'?18:5} fill="#132536" stroke={p.color} strokeWidth="1.5"/>
  <text x={x+10} y={y+14} fill={p.color} fontSize="9" letterSpacing="1">{c.module==='power'?'POWER MODULE':c.module==='engine'?'ENGINE NODE':'SLEEPING QUARTERS'}</text>
  {c.module==='quarters'?<Picture src={art.bunk} x={x+10} y={y+26} w={36} h={27}/>:c.module==='power'?<g>{[0,1,2].map(n=><g key={n}><rect x={x+12+n*10} y={y+27} width="7" height="25" fill="#233e50" stroke="#607b8c"/><rect x={x+14+n*10} y={y+32} width="3" height="16" fill={p.color}/></g>)}</g>:<g><rect x={x+11} y={y+27} width="33" height="25" rx="8" fill="#233e50" stroke="#617b8f"/>{[0,1,2].map(n=><path key={n} d={`M${x+18+n*8} ${y+30}v19`} stroke={p.color} strokeWidth="3"/>)}</g>}
  <text x={x+55} y={y+34} fill="#c6dae6" fontSize="11">{p.env}</text><text x={x+55} y={y+50} fill="#7796aa" fontSize="7">{c.module==='power'?'COMPUTE CAPACITY':c.module==='engine'?'ACTIVE THROUGHPUT':'PARKED CREW'}</text>
 </g>;})}
 <text x="32" y="32" fill="#617c91" fontSize="11" letterSpacing="3">SECTOR 07 / NIGHT SHIFT</text>
 </>}
 </svg>;
}
function App(){
 const [c,setC]=useState<Config>(loadConfig); const [selected,setSelected]=useState(0); const [detail,setDetail]=useState(false);
 const [expanded,setExpanded]=useState(false);
 useEffect(()=>{const close=(e:KeyboardEvent)=>{if(e.key==='Escape')setExpanded(false);};window.addEventListener('keydown',close);return()=>window.removeEventListener('keydown',close);},[]);
 const [pin,setPin]=useState<Config|null>(null); const [notes,setNotes]=useState(''); const [status,setStatus]=useState('');
 const [saved,setSaved]=useState<{name:string;config:Config;notes:string}[]>(()=>{try{return JSON.parse(localStorage.getItem('t3-spatial-studies')||'[]');}catch{return [];}});
 const preset=presets.find(p=>JSON.stringify(p.config)===JSON.stringify(c));
 const update=(next:Config)=>{next={...presets[2].config,...next};setC(next);history.replaceState(null,'',`?${new URLSearchParams(next).toString()}`);setStatus('');};
 const share=async()=>{try{await navigator.clipboard.writeText(location.href);setStatus('Link copied — includes all seven design choices.');}catch{setStatus('Copy the address bar to share this configuration.');}};
 const save=()=>{const next=[...saved,{name:`Study ${saved.length+1}`,config:{...c},notes}];setSaved(next);localStorage.setItem('t3-spatial-studies',JSON.stringify(next));setStatus('Study saved on this browser.');};
 const download=()=>{const data={configuration:c,selectedProject:projects[selected].name,notes,studies:saved};const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));a.download='t3-station-feedback.json';a.click();URL.revokeObjectURL(a.href);setStatus('Feedback exported with your design choices.');};
 return <><header><a href="/" className="brand">T3<span> / COMMAND</span></a><div className="lab-label">SPATIAL DESIGN LAB <span>EXPLORATION 01</span></div><a href="/styleboard.html?palette=flightdeck-nightshift">Art reference ↗</a></header>
 <main><section className="intro"><div><p className="eyebrow">SAME CREW. DIFFERENT WORLD.</p><h1>Where should the work live?</h1><p>Three spatial studies. One unchanged Flight Deck kit in Night Shift. Choose a direction, then pull it apart.</p></div><div className="fixture"><span className="dot"/> SIMULATED FLEET<br/><small>4 projects · 4 environments · 14 crew</small></div></section>
 <section className="presets" aria-label="Design directions">{presets.map(p=><button key={p.name} className={preset===p?'active':''} onClick={()=>update({...p.config})}><span>{p.name}</span><strong>{p.tag}</strong><p>{p.desc}</p><small>{p.trade}</small></button>)}</section>
 <div className="workspace"><aside><div className="section-head"><h2>Mix the decisions</h2><span>7 AXES</span></div>{(Object.keys(options) as (keyof Config)[]).map((k,i)=><label key={k}><span>{String(i+1).padStart(2,'0')} / {({map:'Map structure',rooms:'Station floor plan',links:'Connections',docks:'Module placement',density:'Information layer',focus:'Visual priority',module:'Utility node role'})[k]}</span><select value={c[k]} onChange={e=>update({...c,[k]:e.target.value})}>{options[k].map(([v,n])=><option key={v} value={v}>{n}</option>)}</select></label>)}<p className="hint">Try the orbital map with system chambers, or the connected deck with a central commons. Every axis is independent.</p><button className="secondary" onClick={()=>{setPin({...c});setStatus('Current configuration pinned as A. Keep mixing B.');}}>Pin current as A</button>{pin&&<button className="text-button" onClick={()=>setPin(null)}>Clear comparison</button>}</aside>
 <section className={`viewer ${expanded?'expanded':''}`}><div className="viewer-toolbar"><div className="tabs"><button className={!detail?'on':''} onClick={()=>setDetail(false)}>Fleet map</button><button className={detail?'on':''} onClick={()=>setDetail(true)}>Station interior</button></div><span>{preset?'PRESET':'CUSTOM MIX'} / {pin?'A ↔ B':'LIVE PREVIEW'}</span><button className="text-button" onClick={()=>setExpanded(!expanded)}>{expanded?'Close expanded view':'Expand preview'}</button></div>
 <div className={`scenes ${pin?'compare':''}`}>{pin&&<div><div className="scene-label">A / PINNED · {options.map.find(o=>o[0]===pin.map)?.[1]}</div><Scene c={pin} selected={selected} onSelect={setSelected} detail={detail}/></div>}<div><div className="scene-label">{pin?'B / CURRENT MIX':'CURRENT STUDY'} · {options.rooms.find(o=>o[0]===c.rooms)?.[1]}</div><Scene c={c} selected={selected} onSelect={setSelected} detail={detail}/></div></div>
 <div className="project-strip">{projects.map((p,i)=><button key={p.name} className={selected===i?'selected':''} onClick={()=>setSelected(i)}><span style={{color:p.color}}>● {p.name}</span><small>{p.state} · {p.crew} crew</small></button>)}</div><div className="inspector"><div><strong>{projects[selected].task}</strong><span>{projects[selected].branch} / {projects[selected].env}</span></div><button className="text-button" onClick={()=>setDetail(!detail)}>{detail?'Return to fleet ↗':'Inspect room plan ↗'}</button></div>
 <p className="hint viewer-hint">Select a station or project below the map. Power = environment capacity; engines = throughput; quarters = parked crew. These are alternative node metaphors. The interior view enlarges the room plan. Connections show spatial ideas; this lab does not simulate pathfinding.</p></section></div>
 <section className="feedback"><div><p className="eyebrow">MAKE THE NEXT PASS SPECIFIC</p><h2>Keep a combination. Tell me why.</h2><p>Notes and saved studies stay in this browser. Export feedback to send your choices and notes together; copied links include the design choices.</p><div className="saved">{saved.map((s,i)=><button key={i} onClick={()=>{update(s.config);setNotes(s.notes);}}>{s.name} ↗</button>)}</div></div><div><label htmlFor="notes">What works? What should change?</label><textarea id="notes" value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Keep the orbit and attached power modules. Prefer chambers over the commons. The operations hub feels too prominent…"/><div className="actions"><button onClick={save}>Save study</button><button onClick={share}>Copy mix link</button><button className="primary" onClick={download}>Export feedback ↓</button></div><p role="status" className="status">{status}</p></div></section>
 <section className="references"><p className="eyebrow">REFERENCE TRAIL / RESEARCHED OCT 11, 2026</p><div><a href="https://store.steampowered.com/app/212680/FTL_Faster_Than_Light/" target="_blank" rel="noreferrer"><strong>FTL: Faster Than Light ↗</strong><p>Compartmentalized systems and crew-scale interiors → connected hull and system chambers.</p></a><a href="https://www.nasa.gov/international-space-station/space-station-facts-and-figures/" target="_blank" rel="noreferrer"><strong>NASA / International Space Station ↗</strong><p>Modules, a major truss axis and dedicated docking → service spine and plug-in wings.</p></a><a href="https://dinopoloclub.com/games/mini-metro/" target="_blank" rel="noreferrer"><strong>Mini Metro / Dinosaur Polo Club ↗</strong><p>Station-and-line network legibility → transit connections and the orbital campus.</p></a></div></section>
 </main><footer>REVIEW PROTOTYPE / Original sprites and palette preserved. Mock data only.</footer></>;
}
createRoot(document.getElementById('root')!).render(<App/>);
