const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');
const { stringify } = require('csv-stringify/sync');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const DATA_DIR = path.join(__dirname, 'data');
const PLAYERS_FILE = path.join(DATA_DIR, 'players.csv');
const OUTPUT_FILE = path.join(DATA_DIR, 'output.csv');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const upload = multer({ dest: DATA_DIR });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- CONFIG ----------
let roleOrder = ['P', 'D', 'C', 'A'];
const ROLE_NAMES = { P: 'Portieri', D: 'Difensori', C: 'Centrocampisti', A: 'Attaccanti' };
let roleSlots = { P: 3, D: 8, C: 8, A: 6 };
let roleMin = { P: 3, D: 8, C: 8, A: 6 };
const STARTING_CREDITS = 500;
let countdownSeconds = 10;
let pendingCountdownSeconds = 30;
const DEFAULT_TEAMS = ['Dinamo Bidet','Giory Team','Joga Bonito','ProSecco','Giannifurgonemujito7','Costozza DC','Collione FC','Dinamo Skarsetti'];
let teamCallOrder = [...DEFAULT_TEAMS]; // ordine di chiamata configurabile

// ---------- STATE ----------
let state = {
  players: [],
  assigned: {},
  roleIndex: 0,             // indice in roleOrder del ruolo attualmente "in chiamata"
  callTurnIndex: 0,          // indice in teamCallOrder di chi deve chiamare
  currentCallerTeam: null,   // nome della squadra a cui tocca chiamare (null se asta finita/non iniziata)
  teams: DEFAULT_TEAMS.map(name => ({ name, credits: STARTING_CREDITS, squad: [] })),
  currentAuction: null,
  pendingSelection: null,    // { player, callerTeam } - selezione in attesa della prima offerta del chiamante
  auctionStarted: false,
  auctionFinished: false,
  recentAssignments: [],
};
let timerInterval = null;

function normalizeRole(r) {
  if (!r) return null;
  r = r.trim().toUpperCase();
  if (['P','POR','PORTIERE'].includes(r)) return 'P';
  if (['D','DIF','DIFENSORE'].includes(r)) return 'D';
  if (['C','CEN','CENTROCAMPISTA'].includes(r)) return 'C';
  if (['A','ATT','ATTACCANTE'].includes(r)) return 'A';
  return null;
}
const COL = { ID:1, NOME:2, RUOLO:4, SQUADRA:10, VALUTAZIONE:6, CARD:16 };
function loadPlayersFromCsv(filePath){
  const raw=fs.readFileSync(filePath,'utf8');
  const rows=parse(raw,{columns:false,skip_empty_lines:true,trim:true,bom:true,relax_column_count:true});
  const players=[];
  rows.forEach(row=>{
    const get=c=>row[c-1]!==undefined?String(row[c-1]).trim():'';
    const id=get(COL.ID), nome=get(COL.NOME), ruolo=normalizeRole(get(COL.RUOLO)), squadra=get(COL.SQUADRA), vRaw=get(COL.VALUTAZIONE), valutazione=vRaw&&!isNaN(Number(vRaw))?Number(vRaw):null, card=get(COL.CARD);
    if(id&&/^[0-9]+$/.test(id)&&ruolo&&nome) players.push({id,ruolo,nome,squadra,valutazione,card});
  });
  return players;
}

function remainingPlayersForRole(role){ return state.players.filter(p=>p.ruolo===role && !state.assigned[p.id]); }
function countRole(team, role){ return team.squad.filter(p=>p.ruolo===role).length; }

// ---------- TURN LOGIC ----------
// Determina di chi è il turno di chiamata: scorre i ruoli in roleOrder a partire da roleIndex;
// per ogni ruolo, salta le squadre che hanno già esaurito gli slot per quel ruolo; se nessuna
// squadra ha più spazio (o non ci sono più giocatori disponibili) passa al ruolo successivo.
function computeNextCaller(){
  while (state.roleIndex < roleOrder.length) {
    const role = roleOrder[state.roleIndex];
    const noPlayersLeft = remainingPlayersForRole(role).length === 0;
    const allTeamsFull = state.teams.every(t => countRole(t, role) >= (roleSlots[role]||0));
    if (noPlayersLeft || allTeamsFull) { state.roleIndex += 1; state.callTurnIndex = 0; continue; }

    const order = teamCallOrder.length ? teamCallOrder : state.teams.map(t=>t.name);
    let found = false;
    for (let i = 0; i < order.length; i++) {
      const idx = (state.callTurnIndex + i) % order.length;
      const teamName = order[idx];
      const team = state.teams.find(t => t.name === teamName);
      if (team && countRole(team, role) < (roleSlots[role]||0)) {
        state.callTurnIndex = idx;
        state.currentCallerTeam = teamName;
        found = true;
        break;
      }
    }
    if (found) return;
    state.roleIndex += 1; state.callTurnIndex = 0;
  }
  state.currentCallerTeam = null;
  state.auctionFinished = true;
  writeOutputCsv();
}

function advanceTurnAfterAuction(){
  const order = teamCallOrder.length ? teamCallOrder : state.teams.map(t=>t.name);
  state.callTurnIndex = (state.callTurnIndex + 1) % order.length;
  computeNextCaller();
}

// Ricalcola tutto da zero (usato dopo cambi di setup): riparte dal primo ruolo/prima squadra
// Se l'asta non è ancora iniziata, non calcola il chiamante (rimane in attesa di /start-auction)
function resetTurnsAndCompute(){
  state.roleIndex = 0;
  state.callTurnIndex = 0;
  state.auctionFinished = false;
  state.currentAuction = null;
  state.pendingSelection = null;
  clearCountdown();
  if (!state.auctionStarted) { state.currentCallerTeam = null; return; }
  if (state.players.length && state.teams.length) computeNextCaller();
  else state.currentCallerTeam = null;
}

// restore
try {
  if (fs.existsSync(STATE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(STATE_FILE,'utf8'));
    if (saved.roleOrder && Array.isArray(saved.roleOrder)) roleOrder = saved.roleOrder;
    if (saved.roleSlots && typeof saved.roleSlots === 'object') roleSlots = { ...roleSlots, ...saved.roleSlots };
    if (saved.roleMin && typeof saved.roleMin === 'object') roleMin = { ...roleMin, ...saved.roleMin };
    if (typeof saved.countdownSeconds === 'number' && saved.countdownSeconds >= 3 && saved.countdownSeconds <= 60) countdownSeconds = saved.countdownSeconds;
    if (typeof saved.pendingCountdownSeconds === 'number' && saved.pendingCountdownSeconds >= 5 && saved.pendingCountdownSeconds <= 120) pendingCountdownSeconds = saved.pendingCountdownSeconds;
    if (saved.teamCallOrder && Array.isArray(saved.teamCallOrder)) teamCallOrder = saved.teamCallOrder;
    if (saved.teams) state.teams = saved.teams;
    if (saved.assigned) state.assigned = saved.assigned;
    if (typeof saved.roleIndex === 'number') state.roleIndex = saved.roleIndex;
    if (typeof saved.callTurnIndex === 'number') state.callTurnIndex = saved.callTurnIndex;
    if (typeof saved.currentCallerTeam === 'string') state.currentCallerTeam = saved.currentCallerTeam;
    if (typeof saved.auctionStarted === 'boolean') state.auctionStarted = saved.auctionStarted;
    if (typeof saved.auctionFinished === 'boolean') state.auctionFinished = saved.auctionFinished;
    if (Array.isArray(saved.recentAssignments)) state.recentAssignments = saved.recentAssignments;
    if (saved.pendingSelection && saved.pendingSelection.player && saved.pendingSelection.callerTeam) state.pendingSelection = saved.pendingSelection;
    // migrazione: vecchia asta con currentBid==0 senza offerte -> diventa pending
    if (saved.currentAuction && saved.currentAuction.player && !saved.currentAuction.currentBidder && saved.currentAuction.currentBid === 0 && !state.pendingSelection) {
      const caller = saved.currentAuction.callerTeam || state.currentCallerTeam;
      if (caller) state.pendingSelection = { player: saved.currentAuction.player, callerTeam: caller };
      // non ripristinare currentAuction vuota
    } else if (saved.currentAuction && saved.currentAuction.player) {
      state.currentAuction = saved.currentAuction;
    }
  }
  if (fs.existsSync(PLAYERS_FILE)) {
    const raw = fs.readFileSync(PLAYERS_FILE,'utf8');
    const rows = parse(raw, { columns:false, skip_empty_lines:true, trim:true, bom:true, relax_column_count:true });
    const players=[];
    rows.forEach(row=>{
      const get=c=>row[c-1]!==undefined?String(row[c-1]).trim():'';
      const id=get(COL.ID), nome=get(COL.NOME), ruolo=normalizeRole(get(COL.RUOLO)), squadra=get(COL.SQUADRA), vRaw=get(COL.VALUTAZIONE), valutazione=vRaw&&!isNaN(Number(vRaw))?Number(vRaw):null, card=get(COL.CARD);
      if(id&&/^[0-9]+$/.test(id)&&ruolo&&nome) players.push({id,ruolo,nome,squadra,valutazione,card});
    });
    if(players.length) state.players = players;
  }
  // se restore incompleto (nessun turno calcolato ma tutto pronto), ricalcola solo se asta già iniziata
  if (state.auctionStarted && state.players.length && !state.currentAuction && !state.pendingSelection && !state.auctionFinished && !state.currentCallerTeam) {
    computeNextCaller();
  }
  // se asta non iniziata, assicurati che non ci sia chiamante attivo
  if (!state.auctionStarted) {
    state.currentCallerTeam = null;
  }
} catch(e){ console.error('Restore error',e); }

function saveState(){
  try{ fs.writeFileSync(STATE_FILE, JSON.stringify({
    teams: state.teams, assigned: state.assigned, roleIndex: state.roleIndex,
    callTurnIndex: state.callTurnIndex, currentCallerTeam: state.currentCallerTeam,
    currentAuction: state.currentAuction,
    pendingSelection: state.pendingSelection,
    auctionStarted: state.auctionStarted, auctionFinished: state.auctionFinished,
    roleOrder, roleSlots, roleMin, countdownSeconds, pendingCountdownSeconds, teamCallOrder,
    recentAssignments: state.recentAssignments
  },null,2)); }catch(e){ console.error(e); }
}
function writeOutputCsv(){
  const rows=Object.entries(state.assigned).map(([pid,info])=>({ Fantasquadra:info.team, 'id Calciatore':pid, Prezzo:info.prezzo }));
  const csv=stringify(rows,{header:true, columns:['Fantasquadra','id Calciatore','Prezzo']});
  fs.writeFileSync(OUTPUT_FILE, csv);
}

function publicState(){
  const callerInfo = {};
  if (state.currentCallerTeam) {
    const t = state.teams.find(x => x.name === state.currentCallerTeam);
    const role = roleOrder[state.roleIndex];
    if (t && role) {
      callerInfo.role = role;
      callerInfo.roleName = ROLE_NAMES[role];
      callerInfo.filled = countRole(t, role);
      callerInfo.max = roleSlots[role];
    }
  }
  return {
    teams: state.teams,
    currentAuction: state.currentAuction,
    pendingSelection: state.pendingSelection,
    roleIndex: state.roleIndex,
    currentRole: roleOrder[state.roleIndex]||null,
    currentRoleName: roleOrder[state.roleIndex]?ROLE_NAMES[roleOrder[state.roleIndex]]:null,
    roleSlots,
    roleMin,
    roleOrder,
    teamCallOrder,
    currentCallerTeam: state.currentCallerTeam,
    callerInfo,
    countdownSeconds,
    pendingCountdownSeconds,
    auctionStarted: state.auctionStarted,
    auctionFinished: state.auctionFinished,
    playersLoaded: state.players.length,
    remainingInRole: state.players.length ? remainingPlayersForRole(roleOrder[state.roleIndex]).length : 0,
    totalAssigned: Object.keys(state.assigned).length,
    recentAssignments: state.recentAssignments,
    allPlayers: state.players,
    assigned: state.assigned,
  };
}
function broadcastState(){ io.emit('state', publicState()); }

// ---------- AUCTION ----------
function startCountdown(customSeconds){
  clearCountdown();
  const sec = typeof customSeconds === 'number' ? customSeconds : countdownSeconds;
  state.currentAuction.deadline=Date.now()+sec*1000;
  timerInterval=setInterval(()=>{
    if(!state.currentAuction){ clearCountdown(); return; }
    const msLeft=state.currentAuction.deadline-Date.now();
    const secondsLeft=Math.max(0,Math.ceil(msLeft/1000));
    io.emit('tick',{secondsLeft});
    if(msLeft<=0) finalizeAuction();
  },250);
}
function clearCountdown(){ if(timerInterval){ clearInterval(timerInterval); timerInterval=null; } }

function finalizeAuction(){
  clearCountdown();
  const auc=state.currentAuction;
  if(!auc) return;
  if(auc.currentBidder){
    state.assigned[auc.player.id]={team:auc.currentBidder, prezzo:auc.currentBid};
    const team=state.teams.find(t=>t.name===auc.currentBidder);
    if(team){ team.credits-=auc.currentBid; team.squad.push({playerId:auc.player.id, nome:auc.player.nome, ruolo:auc.player.ruolo, prezzo:auc.currentBid}); }
    state.recentAssignments.unshift({player:auc.player, team:auc.currentBidder, prezzo:auc.currentBid, timestamp:Date.now()});
    state.recentAssignments = state.recentAssignments.slice(0,30);
    io.emit('assigned',{player:auc.player, team:auc.currentBidder, prezzo:auc.currentBid});
    writeOutputCsv();
  } else { io.emit('unsold',{player:auc.player}); }
  state.currentAuction=null;
  advanceTurnAfterAuction();
  saveState(); broadcastState();
}

function maxBidForTeam(team){
  const total=Object.values(roleMin).reduce((a,b)=>a+b,0);
  const filled=team.squad.length;
  const emptyAfter=total-filled-1;
  return team.credits - Math.max(0, emptyAfter);
}
function placeBid(teamName, amount){
  // Caso 1: selezione pendente in attesa della prima offerta del chiamante
  if(state.pendingSelection && !state.currentAuction){
    if(teamName !== state.pendingSelection.callerTeam) return {ok:false,error:`Solo ${state.pendingSelection.callerTeam} può avviare l'asta con la prima offerta`};
    const team=state.teams.find(t=>t.name===teamName); if(!team) return {ok:false,error:'Squadra non valida'};
    const role=state.pendingSelection.player.ruolo;
    const filled=team.squad.filter(s=>s.ruolo===role).length;
    if(filled>=roleSlots[role]) return {ok:false,error:`Hai già completato gli slot per ${ROLE_NAMES[role]}`};
    const min=1;
    if(amount<min) return {ok:false,error:`Offerta minima ${min}`};
    if(amount>team.credits) return {ok:false,error:'Crediti insufficienti'};
    const max=maxBidForTeam(team);
    if(amount>max) return {ok:false,error:`Devi lasciare 1 credito per slot rimanente (max ${max})`};
    // promuove la selezione pendente ad asta attiva — timer prima offerta (30s)
    state.currentAuction={ player: state.pendingSelection.player, currentBid: amount, currentBidder: teamName, deadline: null };
    state.pendingSelection=null;
    state.auctionStarted=true;
    startCountdown(pendingCountdownSeconds);
    saveState(); broadcastState();
    return {ok:true};
  }
  if(!state.currentAuction) return {ok:false,error:'Nessuna asta in corso'};
  const team=state.teams.find(t=>t.name===teamName); if(!team) return {ok:false,error:'Squadra non valida'};
  const auc=state.currentAuction; const role=auc.player.ruolo;
  const filled=team.squad.filter(s=>s.ruolo===role).length;
  if(filled>=roleSlots[role]) return {ok:false,error:`Hai già completato gli slot per ${ROLE_NAMES[role]}`};
  const min=auc.currentBid>0?auc.currentBid+1:1;
  if(amount<min) return {ok:false,error:`Offerta minima ${min}`};
  if(amount>team.credits) return {ok:false,error:'Crediti insufficienti'};
  const max=maxBidForTeam(team);
  if(amount>max) return {ok:false,error:`Devi lasciare 1 credito per slot rimanente (max ${max})`};
  auc.currentBid=amount; auc.currentBidder=teamName; startCountdown(); broadcastState(); return {ok:true};
}

// ---------- ROUTES ----------
app.post('/upload-players', upload.single('file'), (req,res)=>{
  try{
    const players=loadPlayersFromCsv(req.file.path);
    if(!players.length) throw new Error('Nessun giocatore valido');
    state.players=players; fs.copyFileSync(req.file.path, PLAYERS_FILE);
    if (req.file.path !== PLAYERS_FILE) { try { fs.unlinkSync(req.file.path); } catch(e){} }
    state.assigned={}; state.recentAssignments=[];
    state.teams=DEFAULT_TEAMS.map(n=>({name:n,credits:STARTING_CREDITS,squad:[]}));
    teamCallOrder=[...DEFAULT_TEAMS];
    state.auctionStarted = false;
    resetTurnsAndCompute();
    saveState(); broadcastState(); res.json({ok:true,count:players.length});
  }catch(e){ res.status(400).json({ok:false,error:e.message}); }
});
app.post('/set-team-names',(req,res)=>{
  const {names}=req.body; if(!Array.isArray(names)||names.length!==8) return res.status(400).json({ok:false,error:'Servono 8 nomi'});
  state.teams=names.map(n=>({name:n,credits:STARTING_CREDITS,squad:[]}));
  teamCallOrder=[...names];
  state.assigned={}; state.recentAssignments=[];
  state.auctionStarted = false;
  resetTurnsAndCompute();
  saveState(); broadcastState(); res.json({ok:true});
});
app.post('/set-team-order',(req,res)=>{
  const {order}=req.body;
  const teamNames=state.teams.map(t=>t.name);
  if(!Array.isArray(order) || order.length!==teamNames.length) return res.status(400).json({ok:false,error:'Ordine non valido'});
  if(!order.every(n=>teamNames.includes(n)) || new Set(order).size!==order.length) return res.status(400).json({ok:false,error:'Nomi squadra non validi o duplicati'});
  teamCallOrder=[...order];
  resetTurnsAndCompute();
  saveState(); broadcastState(); res.json({ok:true});
});
app.post('/set-role-order',(req,res)=>{
  const {order}=req.body; if(!Array.isArray(order)||order.length!==4) return res.status(400).json({ok:false,error:'Servono 4 ruoli'});
  const valid=['P','D','C','A']; if(!order.every(r=>valid.includes(r))) return res.status(400).json({ok:false,error:'Ruoli non validi'});
  roleOrder=order;
  resetTurnsAndCompute();
  saveState(); broadcastState(); res.json({ok:true});
});
app.post('/set-countdown',(req,res)=>{
  const {seconds, pendingSeconds}=req.body;
  if(seconds!==undefined){
    const n=Number(seconds);
    if(!n || n<3 || n>60) return res.status(400).json({ok:false,error:'Secondi tra 3 e 60'});
    countdownSeconds=n;
  }
  if(pendingSeconds!==undefined){
    const p=Number(pendingSeconds);
    if(!p || p<5 || p>120) return res.status(400).json({ok:false,error:'Secondi prima offerta tra 5 e 120'});
    pendingCountdownSeconds=p;
  }
  if(seconds===undefined && pendingSeconds===undefined) return res.status(400).json({ok:false,error:'Nessun timer specificato'});
  saveState(); broadcastState(); res.json({ok:true, countdownSeconds, pendingCountdownSeconds});
});
app.post('/set-role-slots',(req,res)=>{
  const {slots, mins} = req.body;
  const roles=['P','D','C','A'];
  if(slots){
    for(const r of roles){
      if(slots[r]!==undefined){
        const v=Number(slots[r]);
        if(!Number.isInteger(v) || v<1 || v>15) return res.status(400).json({ok:false,error:`Max ${r} non valido (1-15)`});
        roleSlots[r]=v;
      }
    }
  }
  if(mins){
    for(const r of roles){
      if(mins[r]!==undefined){
        const v=Number(mins[r]);
        if(!Number.isInteger(v) || v<0 || v>15) return res.status(400).json({ok:false,error:`Min ${r} non valido (0-15)`});
        if(v > roleSlots[r]) return res.status(400).json({ok:false,error:`Min ${r} non può superare max`});
        roleMin[r]=v;
      }
    }
  }
  if (!state.currentAuction && !state.pendingSelection) resetTurnsAndCompute();
  saveState(); broadcastState(); res.json({ok:true, roleSlots, roleMin});
});

// Avvio asta esplicito (CTA dashboard) — prima del click l'asta non può cominciare
app.post('/start-auction',(req,res)=>{
  if(state.auctionStarted) return res.status(400).json({ok:false,error:'Asta già iniziata'});
  if(state.auctionFinished) return res.status(400).json({ok:false,error:'Asta terminata'});
  if(!state.players.length) return res.status(400).json({ok:false,error:'Carica prima i giocatori'});
  state.auctionStarted = true;
  state.roleIndex = 0;
  state.callTurnIndex = 0;
  state.currentCallerTeam = null;
  state.currentAuction = null;
  state.pendingSelection = null;
  clearCountdown();
  computeNextCaller();
  saveState(); broadcastState();
  res.json({ok:true});
});

// La squadra di turno chiama un giocatore: crea una selezione pendente.
// L'asta vera parte solo alla prima offerta del chiamante (timer 30s), così può cambiare idea prima di offrire.
app.post('/call-player',(req,res)=>{
  if(!state.auctionStarted) return res.status(400).json({ok:false,error:'Asta non ancora iniziata'});
  if(state.currentAuction) return res.status(400).json({ok:false,error:'Un\'asta è già in corso'});
  if(state.auctionFinished) return res.status(400).json({ok:false,error:'Asta terminata'});
  const {playerId, team} = req.body;
  if(!state.currentCallerTeam) return res.status(400).json({ok:false,error:'Nessun turno attivo'});
  if(team !== state.currentCallerTeam) return res.status(403).json({ok:false,error:'Non è il turno di questa squadra'});
  const player=state.players.find(p=>p.id===String(playerId));
  if(!player) return res.status(400).json({ok:false,error:'Giocatore non trovato'});
  if(state.assigned[player.id]) return res.status(400).json({ok:false,error:'Giocatore già assegnato'});
  const currentRole=roleOrder[state.roleIndex];
  if(player.ruolo!==currentRole) return res.status(400).json({ok:false,error:`Devi scegliere un giocatore di ruolo ${ROLE_NAMES[currentRole]}`});
  const teamObj=state.teams.find(t=>t.name===team);
  if(countRole(teamObj, currentRole) >= roleSlots[currentRole]) return res.status(400).json({ok:false,error:'Slot esauriti per questo ruolo'});
  // se c'è già una selezione pendente dello stesso chiamante, la sostituisce (cambio idea prima della prima offerta)
  if(state.pendingSelection && state.pendingSelection.callerTeam !== team){
    return res.status(400).json({ok:false,error:'C\'è già una selezione in attesa'});
  }
  state.pendingSelection={ player, callerTeam: team };
  saveState(); broadcastState(); res.json({ok:true});
});

// Admin: salta il turno della squadra corrente senza asta (es. squadra assente/non risponde)
app.post('/skip-turn',(req,res)=>{
  if(!state.auctionStarted) return res.status(400).json({ok:false,error:'Asta non ancora iniziata'});
  if(state.currentAuction) return res.status(400).json({ok:false,error:'Un\'asta è in corso'});
  if(state.pendingSelection) { state.pendingSelection=null; }
  if(!state.currentCallerTeam) return res.status(400).json({ok:false,error:'Nessun turno attivo'});
  advanceTurnAfterAuction();
  saveState(); broadcastState(); res.json({ok:true});
});

// Admin: chiude subito l'asta in corso assegnandola a chi è in testa (o invenduto se nessuna offerta)
app.post('/finalize-now',(req,res)=>{
  if(!state.currentAuction) return res.status(400).json({ok:false,error:'Nessuna asta in corso'});
  finalizeAuction();
  res.json({ok:true});
});
app.post('/skip-player',(req,res)=>{
  if(state.pendingSelection){
    const was=state.pendingSelection.player;
    state.pendingSelection=null;
    io.emit('unsold',{player:was});
    saveState(); broadcastState();
    return res.json({ok:true});
  }
  if(state.currentAuction){ clearCountdown(); io.emit('unsold',{player:state.currentAuction.player}); state.currentAuction=null; advanceTurnAfterAuction(); saveState(); broadcastState(); }
  res.json({ok:true});
});
app.post('/next-role',(req,res)=>{
  if(!state.auctionStarted) return res.status(400).json({ok:false,error:'Asta non ancora iniziata'});
  if(state.auctionFinished) return res.status(400).json({ok:false,error:'Asta già terminata'});
  if(state.currentAuction) return res.status(400).json({ok:false,error:'Chiudi prima l\'asta in corso'});
  if(state.pendingSelection) return res.status(400).json({ok:false,error:'Completa prima la selezione in corso'});
  const currentRole=roleOrder[state.roleIndex];
  if(!currentRole) return res.status(400).json({ok:false,error:'Nessun ruolo attivo'});
  const minNeeded=roleMin[currentRole]||0;
  const lacking=state.teams.filter(t=> countRole(t, currentRole) < minNeeded).map(t=> `${t.name} (${countRole(t, currentRole)}/${minNeeded})`);
  if(lacking.length){
    return res.status(400).json({ok:false,error:`Minimo non raggiunto per ${ROLE_NAMES[currentRole]}: `+lacking.join(', ')});
  }
  // avanza al ruolo successivo
  state.roleIndex+=1;
  state.callTurnIndex=0;
  state.pendingSelection=null;
  state.currentAuction=null;
  clearCountdown();
  if(state.roleIndex >= roleOrder.length){
    state.currentCallerTeam=null;
    state.auctionFinished=true;
    writeOutputCsv();
  } else {
    computeNextCaller();
  }
  saveState(); broadcastState();
  res.json({ok:true, nextRole: roleOrder[state.roleIndex]||null});
});
app.get('/export',(req,res)=>{ writeOutputCsv(); res.download(OUTPUT_FILE,'fantacalcio_risultati.csv'); });
app.get('/team-names',(req,res)=>{ res.json(state.teams.map(t=>t.name)); });
app.post('/force-edit',(req,res)=>{
  const {action,playerId,teamName,prezzo}=req.body;
  if(action==='remove'){
    if(!state.assigned[playerId]) return res.status(400).json({ok:false,error:'Giocatore non assegnato'});
    const info=state.assigned[playerId]; const team=state.teams.find(t=>t.name===info.team);
    if(team){ team.credits+=info.prezzo; team.squad=team.squad.filter(p=>p.playerId!==playerId); }
    delete state.assigned[playerId];
    state.recentAssignments=state.recentAssignments.filter(a=>a.player.id!==playerId);
  } else if(action==='move'){
    if(!state.assigned[playerId]) return res.status(400).json({ok:false,error:'Giocatore non assegnato'});
    const old=state.assigned[playerId]; const oldTeam=state.teams.find(t=>t.name===old.team);
    if(oldTeam){ oldTeam.credits+=old.prezzo; oldTeam.squad=oldTeam.squad.filter(p=>p.playerId!==playerId); }
    const nt=state.teams.find(t=>t.name===teamName); if(!nt) return res.status(400).json({ok:false,error:'Squadra non valida'});
    const np=Number(prezzo)||old.prezzo; nt.credits-=np;
    const pl=state.players.find(p=>p.id===playerId);
    nt.squad.push({playerId, nome:pl?pl.nome:'?', ruolo:pl?pl.ruolo:'?', prezzo:np});
    state.assigned[playerId]={team:teamName, prezzo:np};
    state.recentAssignments=state.recentAssignments.filter(a=>a.player.id!==playerId);
    state.recentAssignments.unshift({player:pl||{id:playerId,nome:'?',ruolo:'?'}, team:teamName, prezzo:np, timestamp:Date.now()});
  } else return res.status(400).json({ok:false,error:'Azione non valida'});
  if (!state.currentAuction && !state.pendingSelection) computeNextCaller();
  writeOutputCsv(); saveState(); broadcastState(); res.json({ok:true});
});
app.post('/set-rosters',(req,res)=>{
  const {teams} = req.body;
  if(!Array.isArray(teams) || teams.length!==8) return res.status(400).json({ok:false,error:'Servono 8 squadre'});
  const newAssigned={};
  const used=new Set();
  for(const t of teams){
    if(!t.name || !Array.isArray(t.squad)) return res.status(400).json({ok:false,error:'Formato squadra non valido'});
    const cnt={P:0,D:0,C:0,A:0};
    for(const p of t.squad){
      if(!p.playerId) return res.status(400).json({ok:false,error:'playerId mancante'});
      if(used.has(p.playerId)) return res.status(400).json({ok:false,error:`Giocatore ${p.playerId} duplicato`});
      used.add(p.playerId);
      cnt[p.ruolo]=(cnt[p.ruolo]||0)+1;
      if(cnt[p.ruolo] > roleSlots[p.ruolo]) return res.status(400).json({ok:false,error:`Troppi ${ROLE_NAMES[p.ruolo]} per ${t.name} (max ${roleSlots[p.ruolo]})`});
      newAssigned[p.playerId]={team:t.name, prezzo:Number(p.prezzo)||1};
    }
  }
  state.teams = teams.map(t=>({ name:String(t.name), credits:Number(t.credits)||STARTING_CREDITS, squad: t.squad.map(p=>({ playerId:String(p.playerId), nome:String(p.nome||'?'), ruolo:String(p.ruolo), prezzo:Number(p.prezzo)||1 })) }));
  state.assigned=newAssigned;
  state.recentAssignments = Object.entries(newAssigned).slice(-20).map(([pid,info])=>{
    const pl=state.players.find(x=>x.id===pid) || {id:pid, nome:info.team, ruolo:'?'};
    return {player:pl, team:info.team, prezzo:info.prezzo, timestamp:Date.now()};
  });
  if (!state.currentAuction && !state.pendingSelection) computeNextCaller();
  writeOutputCsv(); saveState(); broadcastState(); res.json({ok:true});
});
app.post('/assign-player',(req,res)=>{
  const {playerId, teamName, prezzo} = req.body;
  if(!playerId) return res.status(400).json({ok:false,error:'playerId mancante'});
  const pid=String(playerId);
  const player=state.players.find(p=>p.id===pid);
  if(!player) return res.status(400).json({ok:false,error:'Giocatore non trovato'});
  // rimuovi da vecchia squadra se già assegnato
  if(state.assigned[pid]){
    const old=state.assigned[pid];
    const oldTeam=state.teams.find(t=>t.name===old.team);
    if(oldTeam){ oldTeam.credits+=old.prezzo; oldTeam.squad=oldTeam.squad.filter(p=>p.playerId!==pid); }
    delete state.assigned[pid];
    state.recentAssignments=state.recentAssignments.filter(a=>a.player.id!==pid);
  }
  // se teamName vuoto → solo rimozione (svincola)
  if(!teamName){
    writeOutputCsv(); saveState(); broadcastState();
    if (!state.currentAuction && !state.pendingSelection) computeNextCaller();
    return res.json({ok:true});
  }
  const team=state.teams.find(t=>t.name===teamName);
  if(!team) return res.status(400).json({ok:false,error:'Squadra non valida'});
  const price=Number(prezzo);
  if(!price || price<1) return res.status(400).json({ok:false,error:'Prezzo non valido'});
  if(countRole(team, player.ruolo) >= roleSlots[player.ruolo]) return res.status(400).json({ok:false,error:`Slot ${ROLE_NAMES[player.ruolo]} pieni per ${teamName}`});
  if(price>team.credits) return res.status(400).json({ok:false,error:'Crediti insufficienti'});
  const max=maxBidForTeam(team);
  if(price>max) return res.status(400).json({ok:false,error:`Devi lasciare 1 credito per slot rimanente (max ${max})`});
  team.credits-=price;
  team.squad.push({playerId:pid, nome:player.nome, ruolo:player.ruolo, prezzo:price});
  state.assigned[pid]={team:teamName, prezzo:price};
  state.recentAssignments.unshift({player, team:teamName, prezzo:price, timestamp:Date.now()});
  state.recentAssignments=state.recentAssignments.slice(0,30);
  if (!state.currentAuction && !state.pendingSelection) computeNextCaller();
  writeOutputCsv(); saveState(); broadcastState(); res.json({ok:true});
});
app.post('/backup',(req,res)=>{
  try{
    const ts=new Date().toISOString().replace(/[:.]/g,'-');
    const dir=path.join(DATA_DIR,'backups',ts);
    fs.mkdirSync(dir,{recursive:true});
    if(fs.existsSync(STATE_FILE)) fs.copyFileSync(STATE_FILE, path.join(dir,'state.json'));
    if(fs.existsSync(OUTPUT_FILE)) fs.copyFileSync(OUTPUT_FILE, path.join(dir,'output.csv'));
    if(fs.existsSync(PLAYERS_FILE)) fs.copyFileSync(PLAYERS_FILE, path.join(dir,'players.csv'));
    fs.writeFileSync(path.join(dir,'backup.json'), JSON.stringify({timestamp:ts, state, roleOrder, roleSlots, roleMin, countdownSeconds, pendingCountdownSeconds, teamCallOrder},null,2));
    res.json({ok:true, backup:ts});
  }catch(e){ res.status(500).json({ok:false,error:e.message}); }
});
app.get('/backups',(req,res)=>{
  try{
    const base=path.join(DATA_DIR,'backups');
    if(!fs.existsSync(base)) return res.json({backups:[]});
    const list=fs.readdirSync(base).filter(f=>fs.statSync(path.join(base,f)).isDirectory()).sort().reverse();
    res.json({backups:list});
  }catch(e){ res.status(500).json({ok:false,error:e.message}); }
});
app.post('/reset-auction',(req,res)=>{
  try{
    state.assigned={};
    state.recentAssignments=[];
    state.teams.forEach(t=>{ t.credits=STARTING_CREDITS; t.squad=[]; });
    state.roleIndex=0; state.callTurnIndex=0; state.currentCallerTeam=null;
    state.currentAuction=null; state.pendingSelection=null;
    state.auctionStarted=false; state.auctionFinished=false;
    clearCountdown();
    writeOutputCsv(); saveState(); broadcastState();
    res.json({ok:true});
  }catch(e){ res.status(500).json({ok:false,error:e.message}); }
});

io.on('connection', socket=>{
  socket.emit('state', publicState());
  if(state.currentAuction?.deadline){ const s=Math.max(0,Math.ceil((state.currentAuction.deadline-Date.now())/1000)); socket.emit('tick',{secondsLeft:s}); }
  socket.on('bid',({team,amount},cb)=>{ const r=placeBid(team,Number(amount)); if(cb) cb(r); });
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>{ console.log(`\nServer http://localhost:${PORT}/admin.html`); console.log(`Team  http://<IP>:${PORT}/team.html\n`); });
