import {renderAuth,authPaths} from './auth-ui.mjs';
import {mergeStates} from './sync.mjs';
import {todayISO,monthStart,monthEnd,addMonths,addDays,money,parseMoney,categories,expandMovements,forecastDaily,project,metrics,cardDueDate,getOccurrence,updateOccurrence,deleteOccurrence} from './domain.mjs';

const $ = (s, root=document) => root.querySelector(s);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uid = () => crypto.randomUUID();
const dateLabel = d => new Intl.DateTimeFormat('pt-BR',{day:'numeric',month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(d+'T12:00:00Z'));
const monthLabel = d => new Intl.DateTimeFormat('pt-BR',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(d+'T12:00:00Z'));
const shortMonth = d => new Intl.DateTimeFormat('pt-BR',{month:'short',year:'numeric',timeZone:'UTC'}).format(new Date(d+'T12:00:00Z')).replace('.','');
const CAT = [
  {id:'income',label:'entradas',singular:'entrada',symbol:'↙',color:'#65ad53'},
  {id:'expense',label:'saídas',singular:'saída',symbol:'↗',color:'#ef4444'},
  {id:'daily',label:'diários',singular:'diário',symbol:'D',color:'#ec4899'},
  {id:'saving',label:'economias',singular:'economia',symbol:'E',color:'#a7d535'},
  {id:'card',label:'cartão',singular:'cartão',symbol:'C',color:'#9058ef'},
];
const typeInfo = type => CAT.find(c=>c.id===type) || CAT[0];
const svg = (name) => {
  const paths={home:'M3 9 12 4l9 5v11H3Z M7 13h10v4H7Z',saldos:'M4 5h16M4 10h16M4 15h16M4 20h16M7 3v19M16 3v19',totais:'M3 7h7M6 4v6M14 5l5 5m0-5-5 5M3 17h7M14 16h7m-7 4h7',tags:'M4 4h9l7 7-9 9-7-7Z M8 8h.01',menu:'M5 5h14M5 10h14M5 15h14M5 20h14',plus:'M12 5v14M5 12h14',calendar:'M4 6h16v15H4Z M8 3v6m8-6v6M4 11h16',horizon:'M4 4h16v16H4Z M4 10h16M10 4v16',left:'m14 5-7 7 7 7',right:'m10 5 7 7-7 7',doubleleft:'m11 6-6 6 6 6m8-12-6 6 6 6',doubleright:'m5 6 6 6-6 6m8-12 6 6-6 6',close:'m6 6 12 12M6 18 18 6',check:'m5 12 4 4 10-10',chevron:'m7 10 5 5 5-5',settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2',user:'M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8M4 21v-3a8 8 0 0 1 16 0v3',card:'M3 5h18v14H3ZM3 10h18M6 15h4',help:'M9 8a3 3 0 1 1 5 2c-2 1-2 2-2 4M12 18h.01',edit:'m14 4 6 6M4 20l4-1L20 7l-3-3L5 16ZM3 21h18',trash:'M3 6h18M8 6V3h8v3M6 6l1 15h10l1-15M10 10v7m4-7v7',search:'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14m5 12 6 6',message:'M3 4h18v13H8l-5 4Z'};
  return `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name]||paths.menu}"/></svg>`;
};
const action = (name,label,icon,extra='') => `<button type="button" class="icon-button" data-action="${name}" aria-label="${esc(label)}" title="${esc(label)}" ${extra}>${svg(icon)}</button>`;
const typeIcon = t=>`<span class="type-icon type-${t}">${typeInfo(t).symbol}</span>`;
const tagHTML = id => {const t=state.tags.find(t=>t.id===id);return t?`<span class="tag-pill tag-${esc(t.color)}">${esc(t.name)}</span>`:'';};
let state, currentMonth=monthStart(todayISO()), route=location.pathname==='/'?'/saldos':location.pathname;
let drawer=null, editing=null, returnDraft=null, busy=false, toastTimer, lastFocus=null, projectionCache=null;
let account=null,csrfToken='',authConfig={},authEpoch=0,syncStatus='syncing',syncBusy=false,pendingRemote=null,pendingConflict=null,lastSynced=null,formDirty=false;
const syncChannel=typeof BroadcastChannel==='function'?new BroadcastChannel('meu-financeiro-sync-v1'):null;
const root=$('#app'), modal=$('#modal');

function toast(text){$('#toast').textContent=text;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,3800);}
const syncLabels={synced:'sincronizado',syncing:'sincronizando',offline:'sem conexão',conflict:'revisar alteração',pending:'atualização disponível'};
function setSyncStatus(status){syncStatus=status;const el=$('.sync-indicator');if(el){el.dataset.status=status;el.textContent=syncLabels[status];el.title=lastSynced?`Última sincronização às ${lastSynced.toLocaleTimeString('pt-BR')}`:'Sincronização da conta';}}
function authenticatedHeaders(){return {'Content-Type':'application/json','X-CSRF-Token':csrfToken,'X-Account-Id':account?.id||''};}
async function accountFetch(path,options={}){
  const epoch=authEpoch;
  const r=await fetch(path,{credentials:'same-origin',...options,headers:{...authenticatedHeaders(),...options.headers}});
  if(epoch!==authEpoch)throw new Error('A sessão mudou. Entre novamente.');
  if(r.status===401){const failure=await r.clone().json();if(failure.code==='session_expired'){showLogin('Sua sessão terminou. Entre novamente para continuar.');throw new Error('Sessão encerrada.');}}
  if(r.status===409||r.status===403){const data=await r.clone().json();if(data.code==='account_changed'||data.code==='csrf_invalid'){showLogin('A conta ou a sessão mudou em outra aba. Entre novamente.');throw new Error('A sessão mudou.');}}
  if(epoch!==authEpoch)throw new Error('A sessão mudou. Entre novamente.');
  const owner=r.headers.get('X-Account-Id');
  if(owner&&owner!==account?.id){showLogin('A conta mudou em outra aba. Entre novamente.');throw new Error('A conta mudou.');}
  return r;
}
function refreshFinance(){
  const workspace=$('.workspace'),ledger=$('.ledger-scroll');
  const scroll={top:workspace?.scrollTop||0,left:workspace?.scrollLeft||0,ledgerTop:ledger?.scrollTop||0,ledgerLeft:ledger?.scrollLeft||0};
  projectionCache=null;render();
  if($('.workspace')){ $('.workspace').scrollTop=scroll.top;$('.workspace').scrollLeft=scroll.left; }
  if($('.ledger-scroll')){ $('.ledger-scroll').scrollTop=scroll.ledgerTop;$('.ledger-scroll').scrollLeft=scroll.ledgerLeft; }
  if(drawer)renderDrawer();
}
async function saveCandidate(base,local,message){
  const epoch=authEpoch;let candidate=local,comparisonBase=base;
  for(let attempt=0;attempt<3;attempt++){
    if(epoch!==authEpoch||!account)return false;
    const r=await accountFetch('/api/state',{method:'PUT',body:JSON.stringify(candidate)});
    const result=await r.json();
    if(epoch!==authEpoch)return false;
    if(r.ok){state=result;pendingRemote=null;pendingConflict=null;formDirty=false;lastSynced=new Date();setSyncStatus('synced');refreshFinance();syncChannel?.postMessage({type:'saved',userId:account.id,revision:state.revision});toast(message);return true;}
    if(r.status!==409)throw new Error(result.error||'Não foi possível salvar.');
    const fresh=await accountFetch('/api/state');if(!fresh.ok)throw new Error('Não foi possível consultar a versão atual.');
    const remote=await fresh.json();if(epoch!==authEpoch||!account)return false;const merged=mergeStates(comparisonBase,candidate,remote);
    if(merged.conflicts.length){pendingConflict={base:comparisonBase,local:candidate,remote,message,conflicts:merged.conflicts};pendingRemote=remote;setSyncStatus('conflict');showSyncConflict();return false;}
    comparisonBase=remote;candidate=merged.state;
  }
  throw new Error('O planejamento está recebendo outras alterações. Tente salvar novamente.');
}
async function commit(mutator,message='Alterações salvas'){
  if(busy||!account||!state)return false;
  busy=true;const base=structuredClone(state),next=structuredClone(state);setSyncStatus('syncing');
  try{mutator(next);return await saveCandidate(base,next,message);}
  catch(e){if(account)setSyncStatus(e instanceof TypeError?'offline':'conflict');toast(e instanceof TypeError?'Sem conexão. Seu formulário continua aberto; tente salvar novamente.':e.message);return false;}
  finally{busy=false;}
}
function hasOpenDraft(){return modal.open||formDirty;}
async function synchronize(){
  if(!account||!state||busy||syncBusy)return;if(pendingConflict){await checkSession();return;}
  const epoch=authEpoch;syncBusy=true;
  try{
    const r=await accountFetch(`/api/state?since=${state.revision}`);
    if(epoch!==authEpoch)return;
    if(r.status===304){lastSynced=new Date();setSyncStatus(pendingRemote?'pending':'synced');return;}
    if(!r.ok)throw new Error('Não foi possível sincronizar.');
    const remote=await r.json();
    if(epoch!==authEpoch||busy||remote.revision<=state.revision)return;
    lastSynced=new Date();
    if(hasOpenDraft()){pendingRemote=remote;setSyncStatus('pending');return;}
    if(remote.revision!==state.revision){state=remote;refreshFinance();}
    pendingRemote=null;setSyncStatus('synced');
  }catch(e){if(account&&epoch===authEpoch)setSyncStatus('offline');}
  finally{syncBusy=false;}
}
function syncConflictDialog(){let dialog=$('#sync-conflict');if(!dialog){dialog=document.createElement('dialog');dialog.id='sync-conflict';dialog.className='modal';document.body.append(dialog);}return dialog;}
function showSyncConflict(){
  if(!pendingConflict)return;
  const d=syncConflictDialog(),paths=pendingConflict.conflicts.map(c=>c.path).slice(0,6);
  d.innerHTML=`<header class="modal-header"><h2>revisar alteração</h2><button class="icon-button" data-action="conflict-keep" aria-label="Fechar aviso">${svg('close')}</button></header><div class="modal-body"><p>O mesmo registro foi alterado em outra sessão. Seu formulário foi mantido.</p><p class="muted">Você pode carregar a versão atual ou aplicar sua alteração sobre ela. Mudanças independentes serão preservadas.</p><ul class="sync-conflict-paths">${paths.map(p=>`<li>${esc(conflictLabel(p))}</li>`).join('')}</ul><p class="form-error" id="conflict-error" hidden></p></div><footer class="modal-footer sync-conflict-actions"><button class="button secondary" data-action="conflict-refresh">carregar versão atual</button><button class="button primary" data-action="conflict-apply">usar minha alteração</button><button class="text-button" data-action="conflict-keep">manter formulário</button></footer>`;
  if(!d.open)d.showModal();
}
function conflictLabel(path){const names={movements:'movimentação',tags:'tag',cards:'cartão',forecastItems:'previsão',profile:'perfil',preferences:'preferência',checkins:'check-in',amount:'valor',date:'data',description:'descrição',name:'nome',firstName:'nome',lastName:'sobrenome',rules:'regras',references:'vínculos'};return String(path).split(/[./\[\]]/).filter(Boolean).map(p=>names[p]||(p.length>25?'registro':p)).join(' · ');}
function showLogin(message='',path='/login'){
  authEpoch++;account=null;csrfToken='';state=undefined;pendingRemote=null;pendingConflict=null;projectionCache=null;formDirty=false;drawer=null;editing=null;returnDraft=null;lastFocus=null;$('#drawer-root').innerHTML='';modal.close();modal.innerHTML='';$('#sync-conflict')?.close();if($('#sync-conflict'))$('#sync-conflict').innerHTML='';clearTimeout(toastTimer);$('#toast').hidden=true;
  const recoveryLocation=path==='/redefinir-senha'?location.search+location.hash:'';route=path;history.replaceState({},'',path+recoveryLocation);renderAuth(root,{path,...authConfig,message,onAuthenticated:acceptSession,onNavigate:authNavigate});
}
function authNavigate(path,message=''){route=path;history.pushState({},'',path);renderAuth(root,{path,...authConfig,message,onAuthenticated:acceptSession,onNavigate:authNavigate});}
async function acceptSession(result){
  account=result.user;csrfToken=result.csrfToken;authConfig.legacyAvailable=false;authEpoch++;const epoch=authEpoch;formDirty=false;returnDraft=null;pendingRemote=null;pendingConflict=null;
  const r=await accountFetch('/api/state');if(!r.ok)throw new Error('Não foi possível carregar seu planejamento.');
  const loaded=await r.json();if(epoch!==authEpoch)return;state=loaded;currentMonth=state.preferences.period==='year'?todayISO().slice(0,4)+'-01-01':state.preferences.period==='previous'?addMonths(monthStart(todayISO()),-1):monthStart(todayISO());
  if(authPaths.has(route)||route==='/')route='/saldos';history.replaceState({},'',route);lastSynced=new Date();syncStatus='synced';render();syncChannel?.postMessage({type:'session'});
}
async function bootstrap(){
  root.innerHTML='<div class="auth-loading" role="status">Abrindo seu planejamento…</div>';
  try{const r=await fetch('/api/auth/session',{credentials:'same-origin'});if(!r.ok)throw new Error();const session=await r.json();authConfig={legacyAvailable:session.legacyAvailable,passwordResetAvailable:session.passwordResetAvailable};
    if(session.user&&route!=='/redefinir-senha')await acceptSession(session);
    else showLogin('',authPaths.has(route)?route:'/login');
  }catch{root.innerHTML='<div class="empty-state"><h1>Não foi possível conectar</h1><p>Verifique se o servidor está disponível e tente novamente.</p><button class="button primary" id="retry">tentar novamente</button></div>';$('#retry').addEventListener('click',bootstrap);}
}

function navigate(path){formDirty=false;if(pendingRemote&&!modal.open){state=pendingRemote;pendingRemote=null;}route=path;history.pushState({},'',path);closeDrawer();render();}
window.addEventListener('popstate',()=>{route=location.pathname;closeDrawer();render();});
function applyTheme(){let theme=state.preferences.theme;document.documentElement.dataset.theme=theme==='system'?(matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'):theme;}
matchMedia('(prefers-color-scheme:dark)').addEventListener('change',()=>state&&applyTheme());
function balanceClass(value){return value<-100000?'deep-negative':value<0?'negative':value<100000?'low':value<200000?'medium':'high';}
function rangeMonths(){return Array.from({length:12},(_,i)=>addMonths(currentMonth,i));}
function projection(){const end=monthEnd(addMonths(currentMonth,11)),key=`${state.revision}:${currentMonth}:${todayISO()}`;if(projectionCache?.key!==key){const rows=project(state,currentMonth,end,todayISO());projectionCache={key,rows,map:new Map(rows.map(d=>[d.date,d]))};}return projectionCache;}
function isAnnual(){return /^\/totais\//.test(route);}
function title(){const labels={'/menu/previsao-diario':'previsão de diário','/menu/cartao-de-credito':'cartões de crédito','/menu/configuracoes':'configurações','/menu/sugestoes':'sugestões','/totais/diario-medio':'diário médio'};if(labels[route])return labels[route];return route==='/saldos/horizonte'?'horizonte':route.startsWith('/saldos/movimentacoes/')?'movimentação':route.split('/').filter(Boolean).at(-1)?.replaceAll('-',' ')||'saldos';}
function periodBar(){const yearly=isAnnual();return `<div class="period-nav">${action('period-year-back','Ano anterior','doubleleft')}${action('period-back',yearly?'Ano anterior':'Mês anterior','left')}<button class="period-label" data-action="period-picker">${yearly?currentMonth.slice(0,4):route.startsWith('/saldos')?`${shortMonth(currentMonth)} – ${shortMonth(addMonths(currentMonth,11))}`:monthLabel(currentMonth)} ${svg('chevron')}</button>${action('period-next',yearly?'Próximo ano':'Próximo mês','right')}${action('period-year-next','Próximo ano','doubleright')}</div>`;}
function render(){
  if(!account||!state){renderAuth(root,{path:authPaths.has(route)?route:'/login',...authConfig,onAuthenticated:acceptSession,onNavigate:authNavigate});return;}
  applyTheme();document.title=`${title()} · meu financeiro`;
  const primary=route.startsWith('/saldos')?'saldos':route.startsWith('/totais')?'totais':route==='/tags'?'tags':'menu';
  root.innerHTML=`<div class="app-shell"><aside class="sidebar"><button class="brand" data-nav="/saldos" aria-label="Início">${svg('home')}</button><nav aria-label="Principal">${['saldos','totais','tags','menu'].map(n=>`<button class="nav-item ${primary===n?'active':''}" data-nav="/${n}">${svg(n)}<span>${n}</span></button>`).join('')}</nav><div class="sidebar-divider"></div><button class="nav-item" data-action="add">${svg('plus')}<span>adicionar</span></button><button class="nav-item" data-action="today">${svg('calendar')}<span>ir pra hoje</span></button><button class="nav-item ${route==='/saldos/horizonte'?'active':''}" data-nav="/saldos/horizonte">${svg('horizon')}<span>horizonte</span></button><div class="sidebar-bottom"><span class="demo-label">minha conta</span><button class="nav-item" data-action="collapse-nav" aria-label="Recolher menu">${svg('left')}</button></div></aside><main class="main"><header class="topbar"><h1 class="page-title">${esc(title())}</h1>${['saldos','totais','tags'].includes(primary)&&!route.includes('movimentacoes')?periodBar():''}<button class="sync-indicator" data-status="${syncStatus}" data-action="sync-now" title="Sincronização da conta">${syncLabels[syncStatus]}</button></header><div class="workspace">${renderPage()}</div></main></div>`;
}
function renderPage(){
  if(route==='/saldos')return renderLedger();
  if(route==='/saldos/horizonte')return renderHorizon();
  if(route.startsWith('/saldos/movimentacoes/'))return renderDetail(decodeURIComponent(route.split('/').at(-1)));
  if(route==='/totais')return renderTotals();
  if(isAnnual())return renderAnnual();
  if(route==='/tags')return renderTags();
  return renderMenu();
}
function renderLedger(){
  const {map}=projection(),collapsed=state.preferences.collapsed||[];
  return `<div class="ledger-scroll"><div class="months-track">${rangeMonths().map(month=>{
    const days=Number(monthEnd(month).slice(-2)),totals=Object.fromEntries(CAT.map(c=>[c.id,0]));
    const rows=Array.from({length:days},(_,i)=>{const date=month.slice(0,8)+String(i+1).padStart(2,'0'),day=map.get(date),weekend=[0,6].includes(new Date(date+'T12:00:00Z').getUTCDay());return `<tr class="${date===todayISO()?'today':''} ${weekend?'weekend':''}" ${date===todayISO()?'id="today-row"':''}><td class="day-cell ${state.checkins.includes(date)?'checked':''}"><button data-action="checkin" data-date="${date}" aria-label="${state.checkins.includes(date)?'Desmarcar':'Marcar'} check-in ${dateLabel(date)}">${i+1}</button></td>${CAT.map(c=>{const value=day.totals[c.id]+(c.id==='daily'?day.forecast:0);totals[c.id]+=value;return `<td class="financial-cell ${collapsed.includes(c.id)?'column-collapsed':''}"><div class="cell-inner ${!value?'zero':''}"><button class="cell-add type-${c.id}" data-action="add" data-type="${c.id}" data-date="${date}" aria-label="Adicionar ${c.singular} em ${dateLabel(date)}">${typeIcon(c.id)}</button><button class="cell-value" data-action="day" data-type="${c.id}" data-date="${date}" aria-label="Ver ${c.label} em ${dateLabel(date)}">${money(value)}</button></div></td>`}).join('')}<td class="balance-cell balance-${balanceClass(day.balance)}"><button data-action="day" data-date="${date}" aria-label="Saldo ${dateLabel(date)}: ${money(day.balance)}">${money(day.balance)}</button></td></tr>`;}).join('');
    return `<section class="month-panel"><h2 class="month-title">${monthLabel(month)}</h2><table class="ledger"><thead><tr><th class="day-cell">dia</th>${CAT.map(c=>`<th class="${collapsed.includes(c.id)?'column-collapsed':''}"><button data-action="toggle-column" data-type="${c.id}" title="Recolher/expandir ${c.label}">${typeIcon(c.id)}<span>${c.label}</span></button></th>`).join('')}<th class="balance-heading">saldos</th></tr></thead><tbody>${rows}</tbody><tfoot><tr class="totals-row"><td></td>${CAT.map(c=>`<td class="${collapsed.includes(c.id)?'column-collapsed':''}"><button data-action="month-list" data-month="${month}" data-type="${c.id}">${typeIcon(c.id)}<span>${money(totals[c.id])}</span></button></td>`).join('')}<td></td></tr></tfoot></table></section>`;
  }).join('')}</div></div>`;
}
function renderHorizon(){const {map}=projection(),months=rangeMonths();return `<div class="horizon-scroll"><table class="horizon-table"><thead><tr>${months.map(m=>`<th colspan="2">${shortMonth(m)}</th>`).join('')}</tr><tr>${months.map(()=>'<th>dia</th><th>saldo</th>').join('')}</tr></thead><tbody>${Array.from({length:31},(_,i)=>`<tr>${months.map(m=>{const date=m.slice(0,8)+String(i+1).padStart(2,'0'),d=map.get(date);return d?`<td class="day-cell ${date===todayISO()?'today':''}">${i+1}</td><td class="balance-cell balance-${balanceClass(d.balance)}"><button data-action="day" data-date="${date}" title="${dateLabel(date)} · ${money(d.balance)}">${Math.abs(d.balance)>=100000?(d.balance/100000).toFixed(2).replace(/0$/,'')+'K':(d.balance/100).toLocaleString('pt-BR',{maximumFractionDigits:2})}</button></td>`:'<td class="absent"></td><td class="absent"></td>';}).join('')}</tr>`).join('')}</tbody></table></div>`;}
const metricDefs=[['performance','performance','O que entra menos o que sai.'],['saved','economizado','Parte das suas entradas destinada a economias.'],['cost','custo de vida','Saídas, diários, cartão e previsão.'],['average','diário médio','Seus gastos diários registrados por dia.']];
const metricRoutes={performance:'performance',saved:'economizado',cost:'custo-de-vida',average:'diario-medio'};
function formatMetric(key,value){return key==='saved'?(value===null?'—':value.toLocaleString('pt-BR',{maximumFractionDigits:2})+'%'):money(value);}
function renderTotals(){const m=metrics(state,currentMonth,monthEnd(currentMonth),todayISO());return `<div class="content-page"><div class="metric-grid">${metricDefs.map(([key,label,description])=>`<button class="metric-card" data-nav="/totais/${metricRoutes[key]}"><span class="metric-title">${label} <span>↗</span></span><strong class="metric-value ${key==='performance'?(m[key]<0?'negative':'positive'):''}">${formatMetric(key,m[key])}</strong><span class="metric-description">${description}</span></button>`).join('')}</div><div class="section-heading"><h2>movimentações</h2><button class="text-button" data-action="month-list" data-month="${currentMonth}">ver todas →</button></div><div class="breakdown-list">${CAT.map(c=>`<button class="breakdown-row" data-action="month-list" data-type="${c.id}" data-month="${currentMonth}"><span>${typeIcon(c.id)} ${c.label}</span><strong>${money(m[c.id])}</strong>${svg('right')}</button>`).join('')}</div><div class="forecast-note"><div><strong>previsão de diários</strong><p>${money(forecastDaily(state))} por dia nos dias futuros deste mês</p></div><button class="text-button" data-nav="/menu/previsao-diario">${money(m.forecast)} ↗</button></div><p class="muted footnote">As configurações das tags são aplicadas separadamente a cada indicador. Os valores futuros fazem parte do planejamento.</p></div>`;}
function renderAnnual(){const key=Object.keys(metricRoutes).find(k=>route.endsWith(metricRoutes[k]))||'performance',year=currentMonth.slice(0,4),start=year+'-01-01',all=metrics(state,start,year+'-12-31',todayISO(),true);return `<div class="content-page narrow"><button class="text-button" data-nav="/totais">← voltar para totais</button>${key!=='performance'&&key!=='average'?`<div class="annual-summary"><span>${metricDefs.find(m=>m[0]===key)[1]} em ${year}</span><strong>${formatMetric(key,all[key])}</strong>${key==='saved'?`<p>${money(all.savedSaving)} economizados / ${money(all.savedIncome)} em entradas</p>`:''}</div>`:''}<div class="annual-list">${Array.from({length:12},(_,i)=>{const month=addMonths(start,i),m=metrics(state,month,monthEnd(month),todayISO(),true);return `<button class="annual-row" data-action="annual-month" data-month="${month}" data-metric="${key}"><div><strong>${monthLabel(month)}</strong><span class="muted">${key==='saved'?`${money(m.savedSaving)} / ${money(m.savedIncome)}`:key==='average'?`${money(m.averageDaily)} / ${Number(monthEnd(month).slice(-2))} dias`:'ver movimentações'}</span></div><strong class="${key==='performance'&&m[key]<0?'negative':''}">${formatMetric(key,m[key])}</strong>${svg('right')}</button>`}).join('')}</div></div>`;}
function renderTags(){const occurrences=expandMovements(state,currentMonth,monthEnd(currentMonth));return `<div class="content-page narrow"><div class="search-bar">${svg('search')}<input id="tag-search" placeholder="buscar tag" aria-label="Buscar tag"><button class="button primary" data-action="tag-add">${svg('plus')} adicionar</button></div><p class="muted">${100-state.tags.length} de 100 disponíveis</p><div class="panel" id="tag-list">${state.tags.map(t=>{const total=occurrences.filter(o=>o.tagIds.includes(t.id)).reduce((sum,o)=>sum+o.amount,0);return `<div class="list-row tag-list-item" data-name="${esc(t.name.toLocaleLowerCase())}"><button class="row-main" data-action="tag-detail" data-id="${esc(t.id)}">${tagHTML(t.id)}</button><button class="row-amount" data-action="tag-detail" data-id="${esc(t.id)}">${money(total)}</button><div class="row-actions">${action('tag-edit','Editar '+t.name,'edit',`data-id="${esc(t.id)}"`)}${action('tag-delete','Apagar '+t.name,'trash',`data-id="${esc(t.id)}"`)}</div></div>`}).join('')||'<div class="empty-state">Suas tags aparecerão aqui.<br>Adicione uma para organizar as movimentações.</div>'}</div></div>`;}
function menuHeader(label){return `<div class="page-heading"><button class="icon-button" data-nav="/menu" aria-label="Voltar para menu">${svg('left')}</button><h2>${label}</h2></div>`;}
function renderMenu(){
  if(route==='/menu')return `<div class="content-page narrow"><button class="profile-card" data-nav="/menu/perfil"><span class="profile-avatar">${esc(state.profile.firstName.slice(0,1))}</span><span><strong>${esc(state.profile.firstName)} ${esc(state.profile.lastName)}</strong><small>${esc(account.email)}</small></span>${svg('right')}</button><div class="menu-grid">${[['perfil','meu perfil','user'],['previsao-diario','previsão de diário','calendar'],['cartao-de-credito','cartões de crédito','card'],['configuracoes','configurações','settings'],['sugestoes','sugestões','message'],['ajuda','ajuda','help']].map(([path,label,icon])=>`<button class="menu-card" data-nav="/menu/${path}">${svg(icon)}<span>${label}</span>${svg('right')}</button>`).join('')}</div><div class="local-note"><strong>Seu planejamento, na sua conta</strong><p>Alterações são sincronizadas entre as sessões conectadas a este servidor.</p><button class="text-button" data-action="logout">sair da conta</button><button class="text-button" data-action="about">sobre esta versão →</button></div></div>`;
  if(route==='/menu/previsao-diario'){const total=state.forecastItems.reduce((s,x)=>s+x.amount,0);return `<div class="content-page narrow">${menuHeader('previsão de diário')}<p class="muted">Planeje seus gastos do dia a dia. A previsão aparece nos dias futuros do calendário.</p><div class="section-heading"><h3>gastos mensais</h3><button class="button secondary" data-action="forecast-add">+ adicionar</button></div><div class="panel">${state.forecastItems.map(x=>`<div class="list-row"><div class="row-main">${esc(x.description)}</div><strong>${money(x.amount)}</strong><div class="row-actions">${action('forecast-edit','Editar gasto','edit',`data-id="${x.id}"`)}${action('forecast-delete','Apagar gasto','trash',`data-id="${x.id}"`)}</div></div>`).join('')||'<div class="empty-state">Nenhum gasto previsto. Adicione o primeiro.</div>'}</div><div class="breakdown-row"><strong>total mensal</strong><strong>${money(total)}</strong></div><div class="settings-group"><label for="forecast-divisor">dividir por quantos dias?</label><select id="forecast-divisor">${[28,29,30,31].map(n=>`<option ${n===state.preferences.forecastDivisor?'selected':''}>${n}</option>`).join('')}</select></div><div class="metric-card"><span class="metric-title">previsão por dia</span><strong class="metric-value">${money(forecastDaily(state))}</strong><span class="metric-description">A previsão do dia deixa de contar à meia-noite.</span></div></div>`;}
  if(route==='/menu/cartao-de-credito')return `<div class="content-page narrow">${menuHeader('cartões de crédito')}<div class="section-heading"><p class="muted">Organize suas compras pela data de vencimento.</p><button class="button primary" data-action="card-add">+ adicionar</button></div><div class="panel">${state.cards.map(c=>`<div class="list-row"><span class="card-symbol">${svg('card')}</span><div class="row-main"><strong class="row-title">${esc(c.name)}</strong><span class="row-subtitle">fecha dia ${c.closingDay} · vence dia ${c.dueDay}</span></div><div class="row-actions">${action('card-edit','Editar cartão','edit',`data-id="${c.id}"`)}${action('card-delete','Apagar cartão','trash',`data-id="${c.id}"`)}</div></div>`).join('')||'<div class="empty-state">Nenhum cartão cadastrado.</div>'}</div></div>`;
  if(route==='/menu/perfil')return `<div class="content-page narrow">${menuHeader('meu perfil')}<form id="profile-form" class="panel profile-form"><label class="form-field">nome<input name="firstName" value="${esc(state.profile.firstName)}" required maxlength="80" autocomplete="given-name"></label><label class="form-field">sobrenome<input name="lastName" value="${esc(state.profile.lastName)}" maxlength="100" autocomplete="family-name"></label><button class="button primary" type="submit">salvar dados pessoais</button></form><p class="sync-account-email">${esc(account.email)}</p><form id="password-form" class="panel password-panel"><h3>alterar senha</h3><label class="form-field">senha atual<input name="currentPassword" type="password" required autocomplete="current-password"></label><label class="form-field">nova senha<input name="newPassword" type="password" minlength="10" maxlength="128" required autocomplete="new-password"></label><label class="form-field">repetir nova senha<input name="confirmation" type="password" minlength="10" maxlength="128" required autocomplete="new-password"></label><p class="muted">Ao salvar, as outras sessões serão encerradas.</p><p class="form-error" role="alert" hidden></p><button class="button primary" type="submit">salvar senha</button></form><div class="session-actions"><button class="button secondary" data-action="logout">sair da conta</button></div></div>`;
  if(route==='/menu/configuracoes')return `<div class="content-page narrow">${menuHeader('configurações')}<h3>aparência</h3><div class="panel">${[['light','claro'],['dark','escuro'],['system','configuração do sistema']].map(([key,label])=>`<label class="preference-option"><span>${label}</span><input type="radio" name="theme" value="${key}" ${state.preferences.theme===key?'checked':''}></label>`).join('')}</div><h3>dados da conta</h3><div class="panel"><button class="menu-card" data-action="reset"><span>zerar planejamento</span>${svg('right')}</button></div><p class="muted">Remove movimentações, cartões, tags, previsão e check-ins deste planejamento. O perfil e a aparência são mantidos.</p></div>`;
  if(route==='/menu/sugestoes')return `<div class="content-page narrow">${menuHeader('sugestões')}<form id="suggestion-form" data-record-id="${uid()}" class="panel profile-form"><label class="form-field">categoria<select name="category"><option value="suggestion">sugestão</option><option value="improvement">melhoria</option><option value="bug">bug</option><option value="other">outros</option></select></label><label class="form-field">sua mensagem<textarea name="message" id="suggestion-text" maxlength="600" rows="6" required placeholder="O que podemos melhorar?"></textarea><span id="suggestion-counter" class="muted">0 / 600</span></label><button class="button primary">salvar sugestão</button></form><p class="muted">As sugestões ficam registradas na sua conta. Nenhuma mensagem é enviada a terceiros.</p>${state.suggestions.length?`<h3>suas sugestões</h3><div class="panel">${state.suggestions.map(s=>`<div class="list-row"><p>${esc(s.message)}</p></div>`).join('')}</div>`:''}</div>`;
  if(route==='/menu/ajuda')return `<div class="content-page narrow">${menuHeader('ajuda')}<div class="panel">${[['1','performance'],['2','economizado'],['3','custo de vida'],['4','diário médio'],['6','tipos de movimentação']].map(([id,label])=>`<button class="menu-card" data-nav="/menu/ajuda/${id}"><span>${label}</span>${svg('right')}</button>`).join('')}</div></div>`;
  if(route.startsWith('/menu/ajuda/')){const articles={1:['performance','A performance mostra quanto sobra das entradas depois de saídas, diários, economias, cartão e previsão. Um resultado negativo indica que o planejamento usa mais dinheiro do que recebe. As tags podem incluir ou excluir lançamentos deste indicador.'],2:['economizado','É a proporção das entradas destinada às economias: economias ÷ entradas × 100. No ano, usamos a soma das economias dividida pela soma das entradas. Sem entradas, o percentual não tem base de cálculo e aparece como um traço.'],3:['custo de vida','Soma saídas, diários, cartão e previsão futura. Economias não entram neste cálculo. As configurações específicas das tags são respeitadas.'],4:['diário médio','Divide os gastos diários registrados pelos dias decorridos no mês atual. Na visão anual, cada mês usa a quantidade total de dias do mês, seguindo a referência analisada. A previsão futura não entra na média.'],6:['tipos de movimentação','Entradas adicionam dinheiro ao saldo. Saídas representam contas e compromissos. Diários são gastos variáveis do dia a dia. Economias reservam parte do dinheiro e diminuem o saldo disponível. Cartão organiza compromissos na data do vencimento.']};const a=articles[route.split('/').at(-1)]||articles[1];return `<article class="content-page narrow help-article"><button class="text-button" data-nav="/menu/ajuda">← voltar para ajuda</button><h2>${a[0]}</h2><p>${a[1]}</p></article>`;}
  return '<div class="empty-state"><h2>Página não encontrada</h2><button class="button primary" data-nav="/saldos">voltar para saldos</button></div>';
}

function openModal(html,label='Formulário'){lastFocus=document.activeElement;modal.innerHTML=html;modal.setAttribute('aria-label',label);if(!modal.open)modal.showModal();}
function closeModal(){modal.close();editing=null;if(pendingRemote&&!pendingConflict){state=pendingRemote;pendingRemote=null;setSyncStatus('synced');refreshFinance();}if(lastFocus?.isConnected)lastFocus.focus();else if(drawer)$('#drawer-root .drawer-close')?.focus();}
function modalHead(title){return `<header class="modal-header"><h2>${esc(title)}</h2>${action('close-modal','Fechar','close')}</header>`;}
function readMovementForm(){const f=$('#movement-form');if(!f)return null;const fd=new FormData(f);return {type:fd.get('type'),amount:parseMoney(fd.get('amount')),description:fd.get('description'),date:fd.get('date'),cardId:fd.get('cardId')||null,repeat:fd.get('repeat')||'none',count:fd.get('forever')==='on'?null:Number(fd.get('count')||2),tagIds:fd.getAll('tagIds')};}
function openMovement(type='income',date=todayISO(),occ=null,draft=null){
  editing=occ?{sourceId:occ.sourceId,index:occ.index}:null;
  const m=draft||occ||{type,date,amount:0,description:'',tagIds:[],repeat:'none',count:null,cardId:null};
  const c=typeInfo(m.type);
  openModal(`${modalHead(occ?'editar movimentação':'adicionar')}<form id="movement-form" data-record-id="${occ?.sourceId||uid()}"><div class="modal-body"><label class="amount-field"><span>R$</span><input class="amount-input" name="amount" aria-label="Valor" inputmode="decimal" value="${m.amount?(m.amount/100).toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2}):''}" placeholder="0,00" required></label><div class="type-picker">${CAT.map(t=>`<button type="button" class="type-${t.id} ${m.type===t.id?'active':''}" data-action="form-type" data-type="${t.id}" aria-label="Tipo ${t.singular}" title="${t.singular}">${typeIcon(t.id)}<span>${t.singular}</span></button>`).join('')}<input type="hidden" name="type" value="${m.type}"></div><label class="form-field"><span>descrição</span><input name="description" placeholder="${c.singular}" value="${esc(m.description)}" maxlength="200"></label><label class="form-field card-field" ${m.type!=='card'?'hidden':''}><span>cartão</span><select name="cardId"><option value="">sem cartão</option>${state.cards.map(card=>`<option value="${card.id}" ${m.cardId===card.id?'selected':''}>${esc(card.name)}</option>`).join('')}</select></label><label class="form-field"><span id="date-label">${m.type==='card'&&m.cardId?'vencimento':'data'}</span><input name="date" type="date" value="${m.date}" min="${Number(todayISO().slice(0,4))-5}-01-01" max="${Number(todayISO().slice(0,4))+5}-12-31" required></label>${!occ?`<label class="form-field"><span>repetição</span><select name="repeat">${[['none','não repete'],['daily','diariamente'],['weekly','semanalmente'],['monthly','mensalmente'],['installments','parcelado']].map(([v,l])=>`<option value="${v}" ${m.repeat===v?'selected':''}>${l}</option>`).join('')}</select></label><div class="repeat-options" ${m.repeat==='none'?'hidden':''}><label id="forever-label"><input name="forever" type="checkbox" ${m.count===null&&m.repeat!=='installments'?'checked':''}> a perder de vista</label><label>quantidade <input name="count" type="number" min="2" max="600" value="${m.count||2}"></label><p class="muted" id="repeat-preview"></p></div>`:`<label class="form-field"><span>aplicar alteração</span><select name="scope"><option value="one">somente esta movimentação</option><option value="future">esta e as próximas</option><option value="all">toda a série</option></select></label>`}<details class="tag-selector" ${m.tagIds.length?'open':''}><summary>tags <span>${m.tagIds.length||'selecionar'} ${svg('chevron')}</span></summary><input class="tag-filter" placeholder="buscar tag" aria-label="Buscar tags do lançamento"><div class="tag-choices">${state.tags.map(t=>`<label data-tagname="${esc(t.name.toLowerCase())}"><input type="checkbox" name="tagIds" value="${t.id}" ${m.tagIds.includes(t.id)?'checked':''}>${tagHTML(t.id)}</label>`).join('')||'<span class="muted">Nenhuma tag cadastrada</span>'}</div><button type="button" class="text-button" data-action="tag-context">+ nova tag</button></details></div><footer class="modal-footer"><button id="movement-submit" class="button primary type-bg-${m.type}" type="submit">${occ?'salvar alterações':'adicionar '+c.singular}</button></footer></form>`,occ?'Editar movimentação':'Adicionar movimentação');
  // openModal does not change the editing context.
  updateRepeatPreview();
}
function updateRepeatPreview(){const f=$('#movement-form');if(!f||!f.elements.repeat)return;const repeat=f.elements.repeat.value,box=$('.repeat-options',f);box.hidden=repeat==='none';$('#forever-label').hidden=repeat==='installments';if(repeat==='installments')f.elements.forever.checked=false;f.elements.count.disabled=f.elements.forever.checked;const value=parseMoney(f.elements.amount.value)||0,count=Number(f.elements.count.value)||2;$('#repeat-preview').textContent=repeat==='installments'?`${count} parcelas · valor total ${money(value)} · aproximadamente ${money(Math.floor(value/count))} por parcela`:f.elements.forever.checked?'Repete até você encerrar a série.':`${count} repetições de ${money(value)}`;}
const COLORS=['gray','blue','yellow','green','red','purple','pink','brown'];
const colorNames={gray:'cinza',blue:'azul',yellow:'amarelo',green:'verde',red:'vermelho',purple:'roxo',pink:'rosa',brown:'marrom'};
function openTag(id=null){const t=state.tags.find(t=>t.id===id)||{name:'',color:'blue',rules:{balance:true,performance:true,saved:true,cost:true,average:true}};openModal(`${modalHead(id?'editar tag':'adicionar tag')}<form id="tag-form" data-record-id="${id||uid()}" data-id="${id||''}"><div class="modal-body"><label class="form-field">nome<input name="name" value="${esc(t.name)}" required maxlength="60" autofocus></label><div class="color-choices">${COLORS.map(c=>`<label class="color-choice tag-${c}" title="${colorNames[c]}"><input type="radio" name="color" value="${c}" ${t.color===c?'checked':''} aria-label="${colorNames[c]}"><span></span></label>`).join('')}</div><details class="advanced-settings"><summary>configurações avançadas</summary><p class="muted">Escolha onde as movimentações desta tag devem contar.</p><div class="rules-grid">${[['balance','saldos'],['performance','performance'],['saved','economizado'],['cost','custo de vida'],['average','diário médio']].map(([k,l])=>`<label class="rule-row"><span>${l}</span><select name="${k}"><option value="true" ${t.rules[k]?'selected':''}>calcular</option><option value="false" ${!t.rules[k]?'selected':''}>ignorar</option></select></label>`).join('')}</div></details></div><footer class="modal-footer"><button class="button primary">${id?'salvar alterações':'adicionar tag'}</button></footer></form>`,'Configurar tag');}
function openSimple(kind,id=null){const isCard=kind==='card',item=(isCard?state.cards:state.forecastItems).find(x=>x.id===id)||{};openModal(`${modalHead(`${id?'editar':'adicionar'} ${isCard?'cartão':'gasto mensal'}`)}<form id="simple-form" data-record-id="${id||uid()}" data-kind="${kind}" data-id="${id||''}"><div class="modal-body">${isCard?`<label class="form-field">nome<input name="name" value="${esc(item.name||'')}" required maxlength="80"></label><label class="form-field">dia do fechamento<input name="closingDay" type="number" min="1" max="31" value="${item.closingDay||1}" required></label><label class="form-field">dia do vencimento<input name="dueDay" type="number" min="1" max="31" value="${item.dueDay||10}" required></label>`:`<label class="form-field">valor mensal<input name="amount" inputmode="decimal" value="${item.amount?(item.amount/100).toFixed(2).replace('.',','):''}" placeholder="0,00" required></label><label class="form-field">descrição<input name="description" value="${esc(item.description||'')}" maxlength="200" required></label>`}</div><footer class="modal-footer"><button class="button primary">${id?'salvar alterações':'adicionar'}</button></footer></form>`,isCard?'Cartão':'Gasto mensal');}
function confirmAction(title,text,name,data={}){openModal(`${modalHead(title)}<div class="modal-body"><p>${esc(text)}</p>${data.recurring?'<label class="form-field">apagar<select id="delete-scope"><option value="one">somente esta ocorrência</option><option value="future">esta e as próximas</option><option value="all">toda a série</option></select></label>':''}</div><footer class="modal-footer confirm-footer"><button class="button secondary" data-action="close-modal">cancelar</button><button class="button danger" data-action="${name}" ${Object.entries(data).map(([k,v])=>`data-${k}="${esc(v)}"`).join('')}>confirmar</button></footer>`,title);}
function findOccurrence(key){return getOccurrence(state,key);}

function openDrawer(options){lastFocus=document.activeElement;drawer={types:CAT.map(c=>c.id),...options};renderDrawer();$('#drawer-root .drawer-close')?.focus();}
function closeDrawer(){drawer=null;$('#drawer-root').innerHTML='';lastFocus?.focus?.();}
function drawerItems(){return expandMovements(state,drawer.start,drawer.end).filter(o=>drawer.types.includes(o.type)&&(!drawer.tagId||o.tagIds.includes(drawer.tagId))).sort((a,b)=>b.date.localeCompare(a.date)||a.description.localeCompare(b.description));}
function renderDrawer(){if(!drawer)return;const items=drawerItems(),tag=state.tags.find(t=>t.id===drawer.tagId),label=tag?tag.name:drawer.start===drawer.end?dateLabel(drawer.start):monthLabel(drawer.start);$('#drawer-root').innerHTML=`<div class="drawer-overlay" data-action="drawer-backdrop"><section class="drawer" role="dialog" aria-modal="true" aria-label="Movimentações: ${esc(label)}"><header class="drawer-header"><div><h2>${esc(label)}</h2><div class="drawer-period">${action('drawer-prev','Período anterior','left')}${action('drawer-next','Próximo período','right')}</div></div><button class="icon-button drawer-close" data-action="close-drawer" aria-label="Fechar movimentações">${svg('close')}</button></header><div class="drawer-toolbar"><button class="button secondary" data-action="drawer-add">+ adicionar</button>${tag?`<button class="text-button" data-action="tag-edit" data-id="${tag.id}">editar tag</button>`:''}<strong>${money(items.reduce((s,o)=>s+o.amount,0))}</strong></div><div class="filter-bar">${CAT.map(c=>`<label title="${c.label}" class="${drawer.types.includes(c.id)?'selected':''}"><input type="checkbox" name="drawer-type" value="${c.id}" ${drawer.types.includes(c.id)?'checked':''}>${typeIcon(c.id)}<span>${c.label}</span></label>`).join('')}</div><div class="drawer-body">${items.map(o=>`<article class="movement-row"><div class="movement-row-top"><button class="row-main" data-action="movement-detail" data-key="${esc(o.key)}"><span class="row-title">${typeIcon(o.type)} ${esc(o.description||typeInfo(o.type).singular)}</span><span class="movement-date">${dateLabel(o.date)} ${o.repeat!=='none'?`· ↻ ${o.index+1}${o.count?'/'+o.count:''}`:''}</span></button><strong class="movement-value type-${o.type}">${money(o.amount)}</strong></div><div class="movement-tags">${o.tagIds.map(tagHTML).join('')}</div><div class="movement-actions"><button class="text-button" data-action="movement-edit" data-key="${esc(o.key)}">editar</button><button class="text-button" data-action="movement-delete" data-key="${esc(o.key)}">apagar</button></div></article>`).join('')||'<div class="empty-state">Nenhuma movimentação neste período.<button class="button secondary" data-action="drawer-add">+ adicionar movimentação</button></div>'}${drawer.start===drawer.end&&drawer.start>todayISO()&&drawer.types.includes('daily')&&!tag?`<div class="forecast-note"><div><strong>previsão de diário · ${money(forecastDaily(state))}</strong><p>A previsão deste dia zera à meia-noite.</p><button class="text-button" data-nav="/menu/previsao-diario">editar previsão mensal →</button></div></div>`:''}</div></section></div>`;}
function renderDetail(key){const o=findOccurrence(key);if(!o)return '<div class="empty-state">Movimentação não encontrada.</div>';return `<div class="content-page narrow"><button class="text-button" data-nav="/saldos">← voltar para saldos</button><div class="detail-card"><span class="type-${o.type}">${typeIcon(o.type)} ${typeInfo(o.type).singular}</span><h2>${esc(o.description||typeInfo(o.type).singular)}</h2><strong class="metric-value">${money(o.amount)}</strong><div class="breakdown-row"><span>data</span><span>${dateLabel(o.date)}</span></div><div class="breakdown-row"><span>repetição</span><span>${({none:'não repete',daily:'diariamente',weekly:'semanalmente',monthly:'mensalmente',installments:'parcelado'})[o.repeat]} ${o.repeat!=='none'?`· ${o.index+1}${o.count?'/'+o.count:''}`:''}</span></div><div class="movement-tags">${o.tagIds.map(tagHTML).join('')}</div><div class="detail-actions"><button class="button primary" data-action="movement-edit" data-key="${esc(key)}">editar movimentação</button><button class="button secondary" data-action="movement-delete" data-key="${esc(key)}">apagar</button></div></div></div>`;}

document.addEventListener('click',async e=>{
  const link=e.target.closest('[data-nav]');if(link){navigate(link.dataset.nav);return;}
  const b=e.target.closest('[data-action]');if(!b)return;
  const a=b.dataset.action,d=b.dataset;
  if(a==='sync-now'){if(pendingConflict)showSyncConflict();else{await synchronize();if(pendingRemote)toast('Há dados novos. Seu formulário será combinado com eles ao salvar.');else if(syncStatus==='synced')toast('Dados atualizados.');}return;}
  if(a==='conflict-keep'){$('#sync-conflict')?.close();return;}
  if(a==='conflict-refresh'){
    if(pendingConflict){state=pendingConflict.remote;pendingConflict=null;pendingRemote=null;formDirty=false;$('#sync-conflict')?.close();modal.close();editing=null;setSyncStatus('synced');refreshFinance();toast('Versão atual carregada. Você pode revisar e editar novamente.');}return;
  }
  if(a==='conflict-apply'){
    if(!pendingConflict||busy)return;
    const epoch=authEpoch,pending=pendingConflict,merged=mergeStates(pending.base,pending.local,pending.remote,{conflictPreference:'local'});
    if(merged.conflicts.length){const error=$('#conflict-error');error.textContent='Um vínculo ou registro necessário foi removido. Carregue a versão atual e revise a alteração.';error.hidden=false;return;}
    busy=true;b.disabled=true;$('#sync-conflict').close();pendingConflict=null;
    try{if(await saveCandidate(pending.remote,merged.state,pending.message))closeModal();}catch(error){if(epoch===authEpoch&&account){pendingConflict=pending;setSyncStatus('conflict');toast(error.message);showSyncConflict();}}finally{busy=false;}return;
  }
  if(a==='logout'){
    if(busy)return;busy=true;
    try{const response=await accountFetch('/api/auth/logout',{method:'POST',body:'{}'});if(!response.ok)throw new Error('Não foi possível sair. Tente novamente.');syncChannel?.postMessage({type:'session'});showLogin();}catch(error){if(account)toast(error.message);}finally{busy=false;}return;
  }

  if(a==='drawer-backdrop'&&e.target!==b)return;
  if(a==='close-modal'){returnDraft=null;closeModal();return;}
  if(a==='close-drawer'||a==='drawer-backdrop'){closeDrawer();return;}
  if(a==='collapse-nav'){document.body.classList.toggle('nav-collapsed');return;}
  if(a==='add'){openMovement(d.type||'income',d.date||todayISO());return;}
  if(a==='today'){currentMonth=monthStart(todayISO());navigate('/saldos');$('#today-row')?.scrollIntoView({block:'center',inline:'nearest'});return;}
  if(['period-year-back','period-back','period-next','period-year-next'].includes(a)){const change=a.includes('back')?-1:1,months=a.includes('year')||isAnnual()?12:1,next=addMonths(currentMonth,change*months),year=Number(next.slice(0,4)),now=Number(todayISO().slice(0,4));if(Math.abs(year-now)>5){toast('A navegação vai até cinco anos antes ou depois de hoje.');return;}currentMonth=next;render();return;}
  if(a==='period-picker'){openModal(`${modalHead('período')}<div class="modal-body"><button class="menu-card" data-action="period-choice" data-period="current">mês atual + 11 meses</button><button class="menu-card" data-action="period-choice" data-period="previous">mês anterior + 11 meses</button><button class="menu-card" data-action="period-choice" data-period="year">ano atual</button><label class="form-field">ir para mês<input id="jump-month" type="month" value="${currentMonth.slice(0,7)}"></label><button class="button primary" data-action="jump-month">ir para mês</button></div>`,'Escolher período');return;}
  if(a==='period-choice'){currentMonth=d.period==='year'?todayISO().slice(0,4)+'-01-01':d.period==='previous'?addMonths(monthStart(todayISO()),-1):monthStart(todayISO());await commit(s=>s.preferences.period=d.period,'Período salvo');closeModal();render();return;}
  if(a==='jump-month'){const v=$('#jump-month').value;if(v){const y=Number(v.slice(0,4));if(Math.abs(y-Number(todayISO().slice(0,4)))>5){toast('Escolha um ano dentro do intervalo de cinco anos.');return;}currentMonth=v+'-01';closeModal();render();}return;}
  if(a==='toggle-column'){await commit(s=>{const c=s.preferences.collapsed;const i=c.indexOf(d.type);i<0?c.push(d.type):c.splice(i,1);},'Visualização salva');return;}
  if(a==='checkin'){const scroll=$('.ledger-scroll')?.scrollTop;await commit(s=>{const i=s.checkins.indexOf(d.date);i<0?s.checkins.push(d.date):s.checkins.splice(i,1);},'Check-in atualizado');if($('.ledger-scroll'))$('.ledger-scroll').scrollTop=scroll;return;}
  if(a==='day'){openDrawer({start:d.date,end:d.date,types:d.type?[d.type]:CAT.map(c=>c.id)});return;}
  if(a==='month-list'||a==='annual-month'){const types=d.type?[d.type]:d.metric==='cost'?['expense','daily','card']:d.metric==='average'?['daily']:d.metric==='saved'?['income','saving']:CAT.map(c=>c.id);openDrawer({start:d.month,end:monthEnd(d.month),types});return;}
  if(a==='drawer-prev'||a==='drawer-next'){const n=a==='drawer-prev'?-1:1,single=drawer.start===drawer.end;drawer.start=single?addDays(drawer.start,n):addMonths(drawer.start,n);drawer.end=single?drawer.start:monthEnd(drawer.start);renderDrawer();return;}
  if(a==='drawer-add'){openMovement(drawer.types.length===1?drawer.types[0]:'income',drawer.start,null,{type:drawer.types.length===1?drawer.types[0]:'income',date:drawer.start,amount:0,description:'',tagIds:drawer.tagId?[drawer.tagId]:[],repeat:'none',count:null,cardId:null});return;}
  if(a==='movement-detail'){navigate('/saldos/movimentacoes/'+encodeURIComponent(d.key));return;}
  if(a==='movement-edit'){const o=findOccurrence(d.key);if(o)openMovement(o.type,o.date,o);return;}
  if(a==='movement-delete'){const o=findOccurrence(d.key);if(o)confirmAction('apagar movimentação',`${o.description||typeInfo(o.type).singular} · ${money(o.amount)}. Esta ação remove o registro do planejamento.`, 'confirm-movement-delete',{key:d.key,recurring:o.repeat!=='none'});return;}
  if(a==='confirm-movement-delete'){const o=findOccurrence(d.key),scope=$('#delete-scope')?.value||'one';if(!o)return;const ok=await commit(s=>deleteOccurrence(s,o.sourceId,o.index,scope),'Movimentação apagada');if(ok){closeModal();if(route.includes('movimentacoes'))navigate('/saldos');}return;}
  if(a==='form-type'){const f=$('#movement-form');f.elements.type.value=d.type;$('.card-field',f).hidden=d.type!=='card';f.querySelectorAll('.type-picker button').forEach(x=>x.classList.toggle('active',x.dataset.type===d.type));$('#movement-submit').className=`button primary type-bg-${d.type}`;$('#movement-submit').textContent=editing?'salvar alterações':'adicionar '+typeInfo(d.type).singular;$('#date-label').textContent=d.type==='card'&&f.elements.cardId.value?'vencimento':'data';return;}
  if(a==='tag-add'||a==='tag-edit'){returnDraft=null;openTag(d.id||null);return;}
  if(a==='tag-context'){returnDraft={draft:readMovementForm(),editing};openTag();return;}
  if(a==='tag-detail'){openDrawer({start:currentMonth,end:monthEnd(currentMonth),tagId:d.id});return;}
  if(a==='tag-delete'){confirmAction('apagar tag','A tag será removida de todas as movimentações. Os lançamentos serão mantidos e os indicadores recalculados.','confirm-tag-delete',{id:d.id});return;}
  if(a==='confirm-tag-delete'){const ok=await commit(s=>{s.tags=s.tags.filter(t=>t.id!==d.id);for(const m of s.movements){m.tagIds=m.tagIds.filter(id=>id!==d.id);for(const ex of Object.values(m.exceptions)){if(ex.tagIds)ex.tagIds=ex.tagIds.filter(id=>id!==d.id);}}},'Tag apagada');if(ok)closeModal();return;}
  if(['card-add','card-edit','forecast-add','forecast-edit'].includes(a)){openSimple(a.startsWith('card')?'card':'forecast',d.id);return;}
  if(a==='card-delete'||a==='forecast-delete'){confirmAction(a==='card-delete'?'apagar cartão':'apagar gasto previsto',a==='card-delete'?'Os lançamentos serão mantidos nas datas atuais e ficarão sem cartão.':'A previsão dos dias futuros será recalculada.',a==='card-delete'?'confirm-card-delete':'confirm-forecast-delete',{id:d.id});return;}
  if(a==='confirm-card-delete'||a==='confirm-forecast-delete'){const ok=await commit(s=>{if(a==='confirm-card-delete'){s.cards=s.cards.filter(c=>c.id!==d.id);for(const m of s.movements){if(m.cardId===d.id)m.cardId=null;for(const ex of Object.values(m.exceptions)){if(ex.cardId===d.id)ex.cardId=null;}}}else s.forecastItems=s.forecastItems.filter(x=>x.id!==d.id);},'Registro apagado');if(ok)closeModal();return;}
  if(a==='reset'){confirmAction('zerar planejamento','Todos os lançamentos, séries, tags, cartões, previsões e check-ins desta conta serão removidos. Esta operação não pode ser desfeita.','confirm-reset');return;}
  if(a==='confirm-reset'){const ok=await commit(s=>{s.movements=[];s.tags=[];s.cards=[];s.forecastItems=[];s.checkins=[];},'Planejamento zerado');if(ok)closeModal();return;}
  if(a==='about'){openModal(`${modalHead('sobre esta versão')}<div class="modal-body"><p>Recriação funcional baseada na análise da interface do App do Breno.</p><p>Calendário, horizonte, indicadores, repetições, parcelas, tags, cartões e previsão usam dados persistidos na sua conta.</p><p class="muted">Login e sincronização entre sessões estão disponíveis. Acesso pela internet depende da hospedagem. Assinatura, indicações com pagamento e aplicativo nativo ainda não estão conectados.</p></div>`,'Sobre esta versão');}
});

document.addEventListener('change',async e=>{
  const target=e.target;
  if(target.name==='theme')await commit(s=>s.preferences.theme=target.value,'Aparência salva');
  if(target.id==='forecast-divisor')await commit(s=>s.preferences.forecastDivisor=Number(target.value),'Previsão atualizada');
  if(target.name==='drawer-type'){drawer.types=[...document.querySelectorAll('[name="drawer-type"]:checked')].map(x=>x.value);renderDrawer();}
  if(['repeat','forever','count'].includes(target.name))updateRepeatPreview();
  if(target.name==='cardId'){const f=$('#movement-form'),card=state.cards.find(c=>c.id===target.value);$('#date-label').textContent=card?'vencimento':'data';if(card)f.elements.date.value=cardDueDate(todayISO(),card);}
});
document.addEventListener('input',e=>{
  const t=e.target;if(t.closest('#profile-form,#suggestion-form,#password-form'))formDirty=true;
  if(t.id==='tag-search')document.querySelectorAll('.tag-list-item').forEach(row=>row.hidden=!row.dataset.name.includes(t.value.toLowerCase()));
  if(t.classList.contains('tag-filter'))document.querySelectorAll('[data-tagname]').forEach(row=>row.hidden=!row.dataset.tagname.includes(t.value.toLowerCase()));
  if(t.id==='suggestion-text')$('#suggestion-counter').textContent=`${t.value.length} / 600`;
  if(t.name==='amount')updateRepeatPreview();
});

document.addEventListener('submit',async e=>{
  e.preventDefault();const f=e.target,fd=new FormData(f);let ok=false;
  const submit=f.querySelector('[type="submit"],.modal-footer button,button.primary');if(submit)submit.disabled=true;
  try{
    if(f.id==='password-form'){
      const error=f.querySelector('.form-error');error.hidden=true;
      if(fd.get('newPassword')!==fd.get('confirmation')){error.textContent='As senhas precisam ser iguais.';error.hidden=false;return;}
      busy=true;
      try{const response=await accountFetch('/api/auth/password',{method:'POST',body:JSON.stringify({currentPassword:fd.get('currentPassword'),newPassword:fd.get('newPassword')})});const result=await response.json();if(!response.ok)throw new Error(result.error||'Não foi possível alterar a senha.');csrfToken=result.csrfToken;f.reset();formDirty=false;syncChannel?.postMessage({type:'session'});toast('Senha alterada. As outras sessões foram encerradas.');}
      catch(err){error.textContent=err instanceof TypeError?'Sem conexão. Tente novamente.':err.message;error.hidden=false;}
      finally{busy=false;}
      return;
    }
    if(f.id==='movement-form'){
      const m=readMovementForm();if(!Number.isSafeInteger(m.amount)||m.amount<=0){toast('Informe um valor maior que zero, com até dois centavos.');return;}
      if(m.amount>999999999999){toast('O valor informado é muito alto.');return;}
      if(m.repeat==='none')m.count=null;
      if(!m.description.trim())m.description=typeInfo(m.type).singular;
      if(m.type!=='card')m.cardId=null;
      const context=editing&&{...editing},scope=fd.get('scope');
      ok=await commit(s=>{
        if(!context){s.movements.push({...m,id:f.dataset.recordId,exceptions:{},createdAt:new Date().toISOString()});return;}
        const fields={type:m.type,amount:m.amount,description:m.description,date:m.date,cardId:m.cardId,tagIds:m.tagIds};
        const previous=getOccurrence(s,`${context.sourceId}:${context.index}`);
        for(const key of Object.keys(fields)){const same=key==='tagIds'?JSON.stringify([...(previous?.tagIds||[])].sort())===JSON.stringify([...fields.tagIds].sort()):previous?.[key]===fields[key];if(same)delete fields[key];}
        updateOccurrence(s,context.sourceId,context.index,fields,scope);
      },context?'Movimentação atualizada':'Movimentação adicionada');
    }
    if(f.id==='tag-form'){
      if(!f.dataset.id&&state.tags.length>=100){toast('Você atingiu o limite de 100 tags.');return;}
      const name=String(fd.get('name')).trim();if(!name){toast('Informe o nome da tag.');return;}
      const tag={id:f.dataset.recordId,name,color:fd.get('color'),rules:Object.fromEntries(['balance','performance','saved','cost','average'].map(k=>[k,fd.get(k)==='true']))};
      ok=await commit(s=>{const i=s.tags.findIndex(t=>t.id===tag.id);i<0?s.tags.push(tag):s.tags.splice(i,1,tag);},'Tag salva');
      if(ok&&returnDraft){const saved=returnDraft;returnDraft=null;saved.draft.tagIds.push(tag.id);closeModal();const o=saved.editing?findOccurrence(`${saved.editing.sourceId}:${saved.editing.index}`):null;openMovement(saved.draft.type,saved.draft.date,o,saved.draft);return;}
    }
    if(f.id==='simple-form'){
      const card=f.dataset.kind==='card',item=card?{id:f.dataset.recordId,name:String(fd.get('name')).trim(),closingDay:Number(fd.get('closingDay')),dueDay:Number(fd.get('dueDay'))}:{id:f.dataset.recordId,description:String(fd.get('description')).trim(),amount:parseMoney(fd.get('amount'))};
      if(!card&&(!Number.isSafeInteger(item.amount)||item.amount<=0)){toast('Informe um valor maior que zero.');return;}
      ok=await commit(s=>{const list=card?s.cards:s.forecastItems,i=list.findIndex(x=>x.id===item.id);i<0?list.push(item):list.splice(i,1,item);},'Cadastro salvo');
    }
    if(f.id==='profile-form'){await commit(s=>s.profile={...s.profile,firstName:String(fd.get('firstName')).trim(),lastName:String(fd.get('lastName')).trim()},'Perfil salvo');return;}
    if(f.id==='suggestion-form'){const message=String(fd.get('message')).trim();if(!message)return;await commit(s=>s.suggestions.push({id:f.dataset.recordId,category:fd.get('category'),message,createdAt:new Date().toISOString()}),'Sugestão salva na sua conta');return;}
    if(ok)closeModal();
  }finally{if(submit?.isConnected)submit.disabled=false;}
});

document.addEventListener('keydown',e=>{
  if(e.key==='Escape'&&drawer&&!modal.open){closeDrawer();return;}
  if(e.key==='Tab'&&drawer&&!modal.open){const focus=[...document.querySelectorAll('.drawer button,.drawer input,.drawer select')].filter(el=>!el.disabled&&!el.hidden);const first=focus[0],last=focus.at(-1);if(e.shiftKey&&document.activeElement===first){last?.focus();e.preventDefault();}else if(!e.shiftKey&&document.activeElement===last){first?.focus();e.preventDefault();}}
});
modal.addEventListener('click',e=>{if(e.target===modal){const r=modal.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeModal();}});
modal.addEventListener('cancel',()=>{editing=null;returnDraft=null;});
let referenceDay=todayISO();setInterval(()=>{if(account&&state&&todayISO()!==referenceDay){referenceDay=todayISO();projectionCache=null;render();if(drawer)renderDrawer();}},30000);
setInterval(synchronize,5000);
window.addEventListener('focus',synchronize);
window.addEventListener('online',synchronize);
window.addEventListener('offline',()=>account&&setSyncStatus('offline'));
document.addEventListener('visibilitychange',()=>{if(!document.hidden)synchronize();});
syncChannel?.addEventListener('message',event=>{if(event.data.type==='session')checkSession();else if(account&&event.data.userId===account.id)synchronize();});
async function checkSession(){
  if(!account)return;const epoch=authEpoch;
  try{const response=await fetch('/api/auth/session',{credentials:'same-origin'});if(!response.ok)return;const session=await response.json();if(epoch!==authEpoch)return;if(!session.user||session.user.id!==account.id){showLogin('A sessão mudou em outra aba. Entre novamente.');return;}csrfToken=session.csrfToken;}catch{setSyncStatus('offline');}
}
await bootstrap();
