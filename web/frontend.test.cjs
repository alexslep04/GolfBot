const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness() {
  const nodes = new Map(), listeners = {}, requests = [];
  function element() {
    const children = new Map();
    return {innerHTML:'', textContent:'', dataset:{}, hidden:true, open:false, attributes:{},
      classList:{add(){},remove(){},toggle(){}}, style:{setProperty(){}}, addEventListener(){},
      setAttribute(k,v){this.attributes[k]=v;},
      querySelector(key){if(!children.has(key)) children.set(key,element());return children.get(key);},
      showModal(){this.open=true;},close(){this.open=false;},
      append(node){nodes.set(node.id,node);}, get firstElementChild(){return this.querySelector('first');}};
  }
  for(const id of ['app','sheet','toast','social-dialog']) nodes.set(id,element());
  const context = vm.createContext({console,URL,URLSearchParams,Intl,Date,JSON,Math,Set,Map,
    // browser pieces the redesigned UI touches while loading
    performance,queueMicrotask,requestAnimationFrame:()=>1,cancelAnimationFrame(){},navigator:{},
    matchMedia:()=>({matches:false,addEventListener(){}}),getComputedStyle:()=>({}),
    CSS:{supports:()=>false},Image:class{set src(value){}},
    document:{baseURI:'https://example.test/golf/',body:element(),documentElement:element(),
      getElementById:id=>nodes.get(id)||null,createElement:element,
      addEventListener:(type,cb)=>(listeners[type] ||= []).push(cb)},
    window:{addEventListener(){},scrollTo(){},scrollY:0},
    location:{pathname:'/golf/',search:'',origin:'https://example.test'},
    history:{replaceState(){},pushState(){}},localStorage:{getItem(){return null;},setItem(){}},
    setTimeout(){return 1;},clearTimeout(){},setInterval(){},clearInterval(){},confirm:()=>true,
    fetch:async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({pvp:[{label:'Alice <admin>',elo:1210,wins:3,draws:1,losses:2,win_rate:.5}],solo:[],patch:'1.2.0'})};}
  });
  for(const file of ['icons.js','ui.js','board.js','gamepad.js','app.js']) {
    let source=fs.readFileSync(path.join(__dirname,file),'utf8');
    if(file==='app.js') source=source.slice(0,source.lastIndexOf('\n(async () => {'));
    vm.runInContext(source,context,{filename:file});
  }
  const run=source=>vm.runInContext(source,context);
  run('session={username:"Alice",avatar:"a",account:{id:"42"}}; matchOptions={patch:"1.2.0",house_rules:{}};');
  return {run,context,nodes,requests,listeners};
}

test('leaderboard defaults PVP, escapes names, formats fractional win rate',async()=>{
  const h=harness();await h.run('leaderboardPage()');
  const html=h.nodes.get('app').innerHTML;
  assert.match(html,/data-leader-tab="pvp" aria-pressed="true"/);
  // the leader's card and a ranked row for each player, with Elo and W–D–L
  assert.match(html,/class="panel c-p3 stat-hero leader-hero"/);assert.match(html,/class="list-item board-row c-p3"/);
  assert.match(html,/1,210<small>Elo<\/small>/);assert.match(html,/3–1–2/);assert.match(html,/W–D–L/);
  assert.match(html,/Alice &lt;admin&gt;/);assert.match(html,/50%/);
  assert.equal(h.requests[0].url,'/golf/api/leaderboards');
  await h.run('leaderboardPage("solo")');assert.match(h.nodes.get('app').innerHTML,/No Practice streaks yet/);assert.doesNotMatch(h.nodes.get('app').innerHTML,/Best reached/);
});

test('Practice opens on the avatar and rules step, then starts without abandoning saved game',async()=>{
  const h=harness();h.run('enterRoom = next => { globalThis.entered = next; }; centerAvatar = () => {}; session.room_id="saved";');
  await h.run('navigate("solo")');
  assert.equal(h.requests.length,1);assert.equal(h.requests[0].url,'/golf/api/practice');
  const html=h.nodes.get('app').innerHTML;
  assert.match(html,/class="avatar-pick/);assert.match(html,/data-rules-picker/);assert.match(html,/data-setup-go/);
  assert.doesNotMatch(html,/data-setup-back/);
  h.run('saveAvatar("frog")');
  await h.run('submitSetup()');
  assert.equal(h.requests.length,2);assert.equal(h.requests[1].url,'/golf/api/solo');
  const body=JSON.parse(h.requests[1].options.body);
  assert.equal(body.practice,true);assert.equal(body.house_rules,true);assert.equal(body.first,'random');assert.equal(body.best_of,null);
  assert.equal(body.avatar,'frog');
  h.run('applyPreset("vanilla"); draft.first="guest"');
  assert.match(h.run('rulesPicker()'),/Only House rules games count toward your Practice streak/);
  await h.run('submitSetup()');
  const custom=JSON.parse(h.requests[2].options.body);
  assert.equal(custom.house_rules,false);assert.equal(custom.first,'guest');
});

test('advanced defaults account vs bot and current patch even without history',async()=>{
  const h=harness();await h.run('statsPage()');
  const query=new URL(h.requests[0].url,'https://example.test').searchParams;
  assert.equal(query.get('player'),'account:42');assert.equal(query.get('opponent'),'bot:golfbot');assert.equal(query.get('patch'),'1.2.0');
});

test('void offer blocks actions and shows timed reply UI',async()=>{
  const h=harness();h.run('state={id:"room",viewer:1,names:["Alice","Bob"],void_offer:{by:0,expires_at:Date.now()/1000+30},game:{legal:{draw:true}},status:"playing"};renderVoidOffer();');
  assert.equal(h.nodes.get('void-dialog').open,true);
  assert.match(h.nodes.get('void-dialog').innerHTML,/data-void-reply="accept"/);
  assert.match(h.nodes.get('void-dialog').innerHTML,/Completed rounds are preserved/);
  assert.match(h.nodes.get('void-dialog').innerHTML,/NO ELO CHANGE/);
  assert.equal(h.run('actionAllowed("draw")'),false);assert.equal(await h.run('move("draw")'),false);
  assert.equal(h.requests.length,0);
  h.run('state.void_offer=null;renderVoidOffer()');assert.equal(h.nodes.get('void-dialog').open,false);
});

test('rated exit uses an in-game dialog with the server Elo loss',async()=>{
  const h=harness();h.context.confirm=()=>{throw Error('Native popup used');};
  h.run('session.room_id="room";state={id:"room",rated:true,status:"playing",forfeit_elo_loss:37}');
  const leaving=h.run('abandonExisting()');
  assert.equal(h.nodes.get('leave-dialog').open,true);
  assert.match(h.nodes.get('leave-dialog').innerHTML,/37 Elo/);
  assert.equal(h.requests.length,0);
  h.run('resolveLeavePrompt("stay")');
  assert.equal(await leaving,false);
  assert.equal(h.requests.length,0);
});

test('guest exit offers sign-in, and No leaves through the API',async()=>{
  const h=harness();h.context.confirm=()=>{throw Error('Native popup used');};
  h.run('session.account=null;session.room_id="room";state={id:"room",practice:true,game:{phase:"choose"}}');
  const leaving=h.run('abandonExisting()');
  assert.match(h.nodes.get('leave-dialog').innerHTML,/Sign in to keep your streak/);
  assert.match(h.nodes.get('leave-dialog').innerHTML,/No, leave/);
  assert.equal(h.requests.length,0);
  h.run('resolveLeavePrompt("leave")');
  assert.equal(await leaving,true);
  assert.equal(h.requests[0].url,'/golf/api/lobbies/room/leave');
});

test('guest sign-in choice retains the table while opening the account screen',async()=>{
  const h=harness();h.run('session.account=null;session.room_id="room";state={id:"room",practice:true,game:{phase:"choose"}};accountPage=()=>{globalThis.signinOpened=true;}');
  const leaving=h.run('abandonExisting()');
  h.run('resolveLeavePrompt("signin")');
  assert.equal(await leaving,false);
  assert.equal(h.context.signinOpened,true);
  assert.equal(h.run('session.room_id'),'room');
  assert.equal(h.requests.length,0);
});

test('every selectable rule has examples, hidden by default, with only necessary cards',()=>{
  const h=harness();const examples=h.run('RULE_EXAMPLES');assert.equal(Object.keys(examples).length,15);
  assert.equal(examples.royal_pairs[0][1].filter(Boolean).length,2);
  assert.equal(examples.roman_fives[0][1].filter(Boolean).length,3);
  assert.equal(examples.all_in_color[0][1].filter(Boolean).length,6);
  for(const key of Object.keys(examples)) {
    const html=h.run(`ruleHelpCard({key:${JSON.stringify(key)},name:"Rule",description:"Description"})`);
    assert.match(html,/aria-expanded="false"/);assert.match(html,/class="rule-example"[^>]* hidden/);
  }
});


test('rated labels use Elo, modifier totals come from each player, Practice alone shows flame',()=>{
  const h=harness();h.run(`board.el=document.createElement("div");board.view={opp:1};state={viewer:0,names:["Alice","Bot"],rated:true,ratings:[1234,1100],practice:false,connected:[true,true],rules:{},game:{phase:"turn",effect_totals:[8,10],scores:[8,10],effects:[[],[]],turn_order:[0,1],modifier_counts:[2,4],draw_count:20}};renderTags();`);
  assert.match(h.run(`board.el.querySelector("[data-score-for='me']").firstElementChild.innerHTML`),/Alice \(1234\)/);
  assert.match(h.run(`board.el.querySelector("[data-rules-for='opp']").querySelector(".txt").innerHTML`),/4 Modifiers/);
  assert.equal(h.run('board.el.querySelector("[data-practice-streak]").hidden'),true);
  h.run('state.rated=false;state.practice=true;state.streak={current:7,best:9,draws:1};renderTags()');
  assert.doesNotMatch(h.run(`board.el.querySelector("[data-score-for='me']").firstElementChild.innerHTML`),/1234/);
  assert.equal(h.run('board.el.querySelector("[data-practice-streak]").hidden'),false);
  assert.match(h.run('board.el.querySelector("[data-practice-streak]").innerHTML'),/class="digits streak-count" data-count="7"/);
});

test('tables of three mark who is up next: you, the opponent shown, or the one the cycle button turns to',()=>{
  const h=harness();
  const game=(current,next)=>`{phase:"choose",current:${current},decision_player:${current},next_up:${next},legal:{flip:[]},effect_totals:[8,10,3],scores:[8,10,3],effects:[[],[],[]],turn_order:[0,1,2],modifier_counts:[0,0,0],draw_count:20}`;
  const label=`board.el.querySelector("[data-score-for='me']").querySelector("[data-turn-label]").textContent`;
  const aria=key=>h.run(`board.el.querySelector("${key}").attributes["aria-label"]`);
  h.run(`board.el=document.createElement("div");board.view={opp:1};state={viewer:0,status:"playing",names:["Alice","Bob","Cy"],connected:[true,true,true],rules:{},game:${game(2,0)}};renderTags();`);
  assert.equal(h.run(label),"You're next");assert.match(aria("[data-score-for='me']"),/you're up next/);
  assert.doesNotMatch(aria("[data-score-for='opp']"),/up next/);assert.doesNotMatch(aria('[data-cycle-next]'),/up next/);
  // the button that turns to the next opponent carries no name of its own
  assert.doesNotMatch(h.run(`board.el.querySelector("[data-cycle-next]").querySelector(".cycle-ico").innerHTML`),/Cy/);
  h.run(`state.game=${game(0,1)};renderTags();`);
  assert.equal(h.run(label),"Your turn");assert.match(aria("[data-score-for='opp']"),/Bob: 10 points, up next/);
  h.run(`state.game=${game(1,2)};renderTags();`);
  assert.doesNotMatch(aria("[data-score-for='opp']"),/up next/);assert.match(aria('[data-cycle-next]'),/Show Cy's cards \(up next\)/);
  // the round ends with this turn, or it is a two-player table: nobody is next
  h.run(`state.game=${game(1,null)};renderTags();`);assert.doesNotMatch(aria('[data-cycle-next]'),/up next/);
  h.run(`state.names=["Alice","Bob"];state.game=${game(1,0)};state.game.turn_order=[0,1];renderTags();`);
  assert.doesNotMatch(aria("[data-score-for='me']"),/up next/);
});

test('a reaction from a player who is off screen is a tooltip by the cycle button in their colour, with avatar and name',()=>{
  const h=harness();
  h.run(`board.el=document.createElement("div");board.view={opp:1};state={viewer:0,status:"playing",names:["Alice","Bob","Cy <b>"],avatars:["dog","dog","dog"],game:{}};
    opponentEmotesMuted=false;activeEmotes={1:{id:"shocked",sequence:1,ends:Date.now()+4000},2:{id:"laughing",sequence:1,ends:Date.now()+4000}};renderEmotes();`);
  const others=h.run(`board.el.querySelector("[data-emote-others]").innerHTML`),beside=h.run(`board.el.querySelector("[data-emote-layer]").innerHTML`);
  assert.match(others,/class="player-emote other c-s2" data-emote-player="2"/);assert.match(others,/--on:var\(--s2on\)/);
  assert.match(others,/class="emote-who"><svg[^>]*class="ico"[\s\S]*<b>Cy &lt;b&gt;<\/b>/);assert.match(others,/emotes\/laughing\.png/);assert.doesNotMatch(others,/shocked/);
  // the opponent showing still reacts beside their own cards, with no label
  assert.match(beside,/class="player-emote them" data-emote-player="1"/);assert.doesNotMatch(beside,/emote-who|laughing/);
  h.run('opponentEmotesMuted=true;board.signatures={};renderEmotes();');
  assert.equal(h.run(`board.el.querySelector("[data-emote-others]").innerHTML`),'');
});

test('an open rules sheet is redrawn in place by a table update, not closed or slid in again',()=>{
  const h=harness();matchRulesFixture(h);
  // each redraw makes a new panel, as the browser does
  h.run(`globalThis.panels=[];sheetRoot.querySelector=()=>{const made={scrollTop:0,added:[],classList:{add(name){made.added.push(name);}}};panels.push(made);return made;};
    Object.defineProperty(sheetRoot,"innerHTML",{set(html){this.html=html;const made={scrollTop:0,added:[],classList:{add(name){made.added.push(name);}}};panels.push(made);sheetRoot.querySelector=()=>made;},get(){return this.html;}});
    openRulesSheet(0);panels.at(-1).scrollTop=140;state.game.effect_totals=[7,3];closeSheetIfStale();`);
  assert.equal(h.run('sheetRoot.hidden'),false);assert.match(h.run('sheetRoot.innerHTML'),/7 pts/);
  assert.equal(h.run('panels.length'),2);assert.equal(h.run('panels.at(-1).scrollTop'),140);assert.deepEqual([...h.run('panels.at(-1).added')],['settled']);
  // other sheets (stats, menus) are left alone
  h.run('openSheet("<section class=\\"sheet\\">menu</section>");closeSheetIfStale();');
  assert.equal(h.run('sheetRoot.innerHTML'),'<section class="sheet">menu</section>');
});

test('void action posts corrected lobby endpoint and reply payload',async()=>{
  const h=harness();h.run('state={id:"room"};session.room_id="room";accept=next=>{};');
  const click=h.listeners.click.at(-1);
  function event(dataset) { const button={disabled:false,dataset,matches:()=>false,classList:{contains:()=>false}};return {target:{closest:()=>button}}; }
  await click(event({voidOffer:''}));assert.equal(h.requests[0].url,'/golf/api/lobbies/room/void-offer');
  await click(event({voidReply:'accept'}));assert.equal(h.requests[1].url,'/golf/api/lobbies/room/void-reply');assert.deepEqual(JSON.parse(h.requests[1].options.body),{accept:true});
});

test('account unfinished Practice exit uses an in-game save explanation',async()=>{
  const h=harness();h.context.confirm=()=>{throw Error('Native popup used');};
  h.run('session.room_id="room";state={id:"room",practice:true,game:{phase:"choose"}}');
  const leaving=h.run('abandonExisting()');
  assert.match(h.nodes.get('leave-dialog').innerHTML,/saved to your account/);
  h.run('resolveLeavePrompt("stay")');
  assert.equal(await leaving,false);
  assert.equal(h.requests.length,0);
});

test('rule eyes sit on the right of the card, outside description copy',()=>{
  const h=harness();const html=h.run('ruleHelpCard({key:"king_queen",name:"K-Q",description:"Description"})');
  const copy=html.indexOf('class="rule-help-copy"'),eye=html.indexOf('class="rule-eye"');
  assert.ok(copy>=0&&eye>copy);
  // the eye follows the copy's closing tag, so it is not inside the description
  assert.ok(html.slice(copy,eye).includes('class="rule-example"'));
});

test('examples reuse game card markup and front/back flip structure',()=>{
  const h=harness();const html=h.run('exampleHand(["QH",null,"KS",null,null,null])');
  assert.match(html,/example-card is-face/);
  assert.match(html,/class="card-flip"/);
  assert.match(html,/face front red/);
  assert.match(html,/face back/);
  const css=fs.readFileSync(path.join(__dirname,'style.css'),'utf8');
  assert.doesNotMatch(css,/example-card[^}]*background-image:\s*none/);
  assert.doesNotMatch(css,/example-card[^}]*repeating-linear-gradient/);
});

test('streak count is an explicit badge beside flame, including zero',()=>{
  const h=harness();h.run('board.el=document.createElement("div");board.view={opp:1};state={viewer:0,names:["Alice","Bot"],practice:true,streak:{current:0,best:0,draws:0},connected:[true,true],rules:{},game:{phase:"turn",effect_totals:[0,0],scores:[0,0],effects:[[],[]],turn_order:[0,1],modifier_counts:[0,0],draw_count:20}};renderTags()');
  assert.match(h.run('board.el.querySelector("[data-practice-streak]").innerHTML'),/class="digits streak-count" data-count="0"/);
});

test('successful sign-in saves and leaves without asking a second time',async()=>{
  const h=harness();h.run('session.room_id="room";state={id:"room",practice:true,game:{phase:"choose"}};leaveAfterSignIn="room";session.account={id:"42",unique_name:"alice"};home=()=>{};toast=()=>{};');
  assert.equal(await h.run('finishPracticeSignIn()'),true);
  assert.equal(h.requests[0].url,'/golf/api/lobbies/room/leave');
  assert.equal(h.run('session.room_id'),null);
  assert.equal(h.run('leaveAfterSignIn'),null);
});

test('returning to play cancels the sign-in exit detour',async()=>{
  const h=harness();h.run('session.room_id="room";leaveAfterSignIn="room";resume=()=>{};');
  await h.run('navigate("resume")');
  assert.equal(h.run('leaveAfterSignIn'),null);
});

test('stale sign-in finish cannot clear a replacement table',async()=>{
  const h=harness();h.run('session.account={id:"42",unique_name:"alice"};leaveAfterSignIn="old";session.room_id="new";state={id:"new"};home=()=>{globalThis.wentHome=true;};');
  assert.equal(await h.run('finishPracticeSignIn()'),true);
  assert.equal(h.context.wentHome,undefined);
  assert.equal(h.run('session.room_id'),'new');
  assert.equal(h.requests.length,0);
});

test('table replacement during saved-practice exit keeps the new table',async()=>{
  const h=harness();h.run('session.account={id:"42",unique_name:"alice"};leaveAfterSignIn="old";session.room_id="old";state={id:"old",practice:true};home=()=>{globalThis.wentHome=true;};');
  h.context.fetch=async()=>{h.run('tableEpoch++;session.room_id="new";state={id:"new"};');return {ok:true,json:async()=>({left:true})};};
  assert.equal(await h.run('finishPracticeSignIn()'),true);
  assert.equal(h.context.wentHome,undefined);
  assert.equal(h.run('state.id'),'new');
  assert.equal(h.run('session.room_id'),'new');
});


function matchRulesFixture(h) {
  h.run(`catalog=[{key:"holdem",name:"Hold em",description:"Poker"},{key:"king_queen",name:"K-Q",description:"Column"},{key:"tricky_straights",name:"Straights",description:"Row"}];
    state={id:"match",viewer:0,names:["Alice","Bob"],rules:{holdem:true,king_queen:true,tricky_straights:true},house_rules:true,round:1,best_of:5,series_mode:"points",points:[0,0],wins:[0,0],history:[],
      game:{phase:"choose",current:0,deck_count:1,turn_order:[0,1],last_move:"",effects:[[],["Incoming straight row 1: +3"]],scores:[10,3],effect_totals:[5,3],modifier_counts:[1,0],legal:{set_rules:false},
        players:[[{visible:true,card:{rank:13,label:"K",suit:"H"}},{visible:true,card:{rank:8,label:"8",suit:"S"}},{visible:false,card:null},{visible:true,card:{rank:12,label:"Q",suit:"D"}},{visible:false,card:null},{visible:true,card:{rank:4,label:"4",suit:"C"}}],Array.from({length:6},()=>({visible:false,card:null}))],rule_previews:[{king_queen:{indices:[0,3]}},{}]}};`);
}

test('match rules reuse eye controls and place source-active rules first',()=>{
  const h=harness();matchRulesFixture(h);
  const html=h.run('rulesSheet(0)');
  assert.match(html,/data-rule-example="match-0-king_queen"/);
  assert.ok(html.indexOf('Show examples for K-Q')<html.indexOf('Show examples for Hold em'));
  assert.match(html,/K-Q <span class="pill">active/);
  assert.equal(h.run('activeRules(1).length'),0);
});

test('active match example uses actual contributing cards with every other slot hidden',()=>{
  const h=harness();matchRulesFixture(h);
  const html=h.run('ruleHelpCard(catalog[1],{player:0,on:true})');
  assert.match(html,/Your current cards/);
  assert.match(html,/aria-label="KH, face down, face down, QD, face down, face down"/);
  assert.doesNotMatch(html,/Same-color King-Queen column/);
  assert.equal((html.match(/example-card is-face/g)||[]).length,2);
  const inactive=h.run('ruleHelpCard(catalog[0],{player:0,on:true})');
  assert.match(inactive,/Five-card flush/);
});

test('match preview never reveals a hidden card even if a stale mask includes it',()=>{
  const h=harness();matchRulesFixture(h);
  h.run('state.game.rule_previews[0].king_queen.indices=[0,2,3];state.game.players[0][2]={visible:false,card:{rank:1,label:"A",suit:"S"}};');
  const html=h.run('ruleHelpCard(catalog[1],{player:0,on:true})');
  assert.doesNotMatch(html,/AS/);
  assert.match(html,/KH, face down, face down, QD/);
});

test('earned modifier with no remaining contributing cards stays active without invented cards',()=>{
  const h=harness();matchRulesFixture(h);
  h.run('state.game.rule_previews[0]={gamblers_row:{indices:[],note:"Earned earlier; the row no longer needs to remain."}};');
  const html=h.run('ruleHelpCard({key:"gamblers_row",name:"777",description:"Earned"},{player:0,on:true})');
  assert.match(html,/Earned earlier/);
  assert.equal((html.match(/example-card is-face/g)||[]).length,0);
  assert.match(html,/pill">active/);
});

test('match eye toggles remain open across live updates and are isolated by player',async()=>{
  const h=harness();matchRulesFixture(h);
  h.nodes.set('example-match-0-king_queen',{hidden:true});
  const click=h.listeners.click.at(-1);
  const button={disabled:false,dataset:{ruleExample:'match-0-king_queen',rulePlayer:'0',ruleKey:'king_queen'},matches:()=>false,classList:{contains:()=>false,toggle(){}},setAttribute(){}};
  await click({target:{closest:()=>button}});
  assert.match(h.run('rulesSheet(0)'),/data-rule-example="match-0-king_queen"[^>]*aria-expanded="true"/);
  assert.match(h.run('ruleHelpCard(catalog[1],{player:1,on:true})'),/aria-expanded="false"/);
  h.run('state.game.rule_previews[0]={};');
  assert.match(h.run('rulesSheet(0)'),/Five-card flush/);
  assert.match(h.run('ruleHelpCard(catalog[1],{player:0,on:true})'),/aria-expanded="true"/);
  h.run('state.id="another-match";');
  assert.match(h.run('ruleHelpCard(catalog[1],{player:0,on:true})'),/aria-expanded="false"/);
});

test('Solo shows best streak with W-D-L and win rate instead of current streak',async()=>{
  const h=harness();h.context.fetch=async()=>({ok:true,json:async()=>({patch:'1.2.0',solo:[{label:'Alice',best_streak:8,current_streak:3,wins:6,draws:2,losses:2,win_rate:.6}]})});
  await h.run('leaderboardPage("solo")');
  const html=h.nodes.get('app').innerHTML;
  assert.match(html,/best streak/);assert.match(html,/best streak 8/);
  assert.match(html,/W–D–L/);assert.match(html,/win rate/);
  assert.match(html,/6–2–2/);assert.match(html,/60%/);
  assert.doesNotMatch(html,/Current streak|Best reached/);
});
