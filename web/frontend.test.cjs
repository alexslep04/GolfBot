const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness({debug=false}={}) {
  const nodes = new Map(), listeners = {}, requests = [];
  function element() {
    const children = new Map();
    return {innerHTML:'', textContent:'', dataset:{}, hidden:true, open:false, attributes:{},
      classList:{add(){},remove(){},toggle(){}}, style:{setProperty(){}}, addEventListener(){},
      setAttribute(k,v){this.attributes[k]=v;},
      querySelector(key){if(!children.has(key)) children.set(key,element());return children.get(key);}, querySelectorAll:()=>[],
      showModal(){this.open=true;},close(){this.open=false;},
      append(node){nodes.set(node.id,node);}, get firstElementChild(){return this.querySelector('first');}};
  }
  for(const id of ['app','sheet','toast','social-dialog','queue-banner']) nodes.set(id,element());
  const context = vm.createContext({console,URL,URLSearchParams,Intl,Date,JSON,Math,Set,Map,
    // browser pieces the redesigned UI touches while loading
    performance,queueMicrotask,requestAnimationFrame:()=>1,cancelAnimationFrame(){},navigator:{},
    matchMedia:()=>({matches:false,addEventListener(){}}),getComputedStyle:()=>({}),
    CSS:{supports:()=>false},Image:class{set src(value){}},
    document:{baseURI:'https://example.test/golf/',body:element(),documentElement:element(),
      getElementById:id=>nodes.get(id)||null,querySelector:()=>null,querySelectorAll:()=>[],createElement:element,
      addEventListener:(type,cb)=>(listeners[type] ||= []).push(cb)},
    window:{addEventListener(){},scrollTo(){},scrollY:0},
    location:{pathname:'/golf/',search:'',origin:'https://example.test'},
    history:{replaceState(){},pushState(){}},localStorage:{getItem(){return null;},setItem(){}},
    setTimeout(){return 1;},clearTimeout(){},setInterval(){},clearInterval(){},confirm:()=>true,
    fetch:async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({pvp:[{label:'Alice <admin>',mmr:1210,provisional:true,wins:3,draws:1,losses:2,win_rate:.5,games:{wins:11,draws:2,losses:9}}],solo:[],patch:'1.2.0'})};}
  });
  for(const file of ['icons.js','ui.js','board.js','gamepad.js','tournament.js','tabs.js','app.js']) {
    // debug: a debug server's page, as far as ui.js's theme list goes (app.js's
    // debug tools need more of a browser than this harness has)
    if(debug && file==='ui.js') context.document.documentElement.dataset.debug='';
    else delete context.document.documentElement.dataset.debug;
    let source=fs.readFileSync(path.join(__dirname,file),'utf8');
    if(file==='app.js') source=source.slice(0,source.lastIndexOf('\n(async () => {'));
    vm.runInContext(source,context,{filename:file});
  }
  const run=source=>vm.runInContext(source,context);
  run('session={username:"Alice",avatar:"a",account:{id:"42"}}; matchOptions={patch:"1.2.0",house_rules:{}};');
  return {run,context,nodes,requests,listeners};
}

// Aces: the leaderboards and records, a view at a time, under the tab's big title.
test('Aces PvP ranks by MMR, escapes names, formats fractional win rate; it loads the leaderboards',async()=>{
  const h=harness();
  await h.run('loadTab("aces")');
  assert.equal(h.requests[0].url,'/golf/api/leaderboards');
  h.run('acesView="pvp"');
  const html=h.run('acesPaneHtml()');
  assert.match(html,/PvP Rankings/);
  // the leader's card and a ranked row for each player, with MMR (still settling: "?") and the series W–D–L
  assert.match(html,/class="panel c-p3 stat-hero leader-hero"/);assert.match(html,/class="list-item board-row c-p3"/);
  assert.match(html,/1,210\?<small>MMR<\/small>/);assert.match(html,/Series 3–1–2/);assert.match(html,/series W–D–L/);
  assert.match(html,/Games 11–2–9/);assert.doesNotMatch(html,/still settling|leader-foot/);assert.doesNotMatch(html,/Elo/);
  assert.match(html,/Alice &lt;admin&gt;/);assert.match(html,/50%/);
  h.run('acesView="solo"');assert.match(h.run('acesPaneHtml()'),/No solo streaks yet/);
  // the views sit above the tab bar, the one showing marked
  assert.match(h.run('acesTabsHtml()'),/data-aces-view="solo" aria-pressed="true"/);
});

test('Play solo starts a House rules game straight away, with no lobby, without abandoning a saved game',async()=>{
  const h=harness();h.run('enterRoom = next => { globalThis.entered = next; }; session.room_id="saved"; saveAvatar("frog")');
  await h.run('navigate("solo")');
  assert.deepEqual(h.requests.map(r=>r.url),['/golf/api/solo']);
  const body=JSON.parse(h.requests[0].options.body);
  assert.equal(body.practice,true);assert.equal(body.house_rules,true);assert.equal(body.best_of,null);assert.equal(body.avatar,'frog');
  assert.equal('rules' in body,false);
  assert.doesNotMatch(h.nodes.get('app').innerHTML,/data-rules-picker|continues with the rules/);
});

test('Your stats (once Advanced stats) are yours against everyone, over every game',async()=>{
  const h=harness();await h.run('loadMyStats()');
  const query=new URL(h.requests[0].url,'https://example.test').searchParams;
  assert.equal(query.get('player'),'account:42');assert.equal(query.get('opponent'),'');
  assert.equal(query.get('house_rules'),'false');assert.equal(query.get('patch'),null); // every patch counts
});

test('PVP ranks by MMR from series, with games counted apart; Solo is all time',()=>{
  const h=harness();
  const pvp=h.run('leaderboardBody("pvp",{patch:"1.4.0",pvp:[{id:"account:1",label:"Ann",mmr:1040,provisional:false,wins:7,draws:1,losses:4,win_rate:.58,game_rating:1090,games:{wins:30,draws:2,losses:21}}]})');
  assert.match(pvp,/Series 7–1–4/);assert.match(pvp,/Games 30–2–21/);assert.match(pvp,/1,040<small>MMR<\/small>/);
  // the game rating is not on the board (it is in Advanced stats), and MMR is not tied to a patch
  assert.doesNotMatch(pvp,/1,090/);assert.doesNotMatch(pvp,/Patch 1\.4\.0/);assert.doesNotMatch(pvp,/still settling/);
  assert.match(h.run('leaderboardBody("pvp",{pvp:[]})'),/Finish a Ranked series to get on the board/);
  const solo=h.run('leaderboardBody("solo",{patch:"1.3.0",solo:[{id:"account:1",label:"Ann",best_streak:9,current_streak:2,wins:20,draws:1,losses:5,win_rate:.77}]})');
  assert.doesNotMatch(solo,/Ranked by best solo streak/);assert.doesNotMatch(solo,/Patch 1\.3\.0/);assert.doesNotMatch(solo,/Series/);assert.doesNotMatch(solo,/MMR/);
});

test('records show the biggest yapper, the longest 1v1 game, the bogey monster and the party',()=>{
  const h=harness();
  const html=h.run('recordsBody({yapper:{id:"account:1",label:"Ann",emotes:1234},longest_pvp:{turns:41,players:["Ann","Bob"],scores:[12,9],label:"Bob"},bogey:{id:"account:2",label:"Bob <b>",points:57,scores:[57,3]},party:{count:3,players:["Ann","Bob","Cy"],seats:4}})');
  assert.match(html,/Biggest yapper/);assert.match(html,/has sent the most emotes/);
  assert.match(html,/Longest 1v1 game/);assert.match(html,/It&#39;s a party|It's a party/);assert.match(html,/Ann, Bob, Cy<\/strong> all played in one game of 4/);assert.match(html,/Ann vs Bob/);assert.match(html,/after 41 turns/);
  assert.match(html,/Bogey monster/);assert.match(html,/Bob &lt;b&gt;/);assert.match(html,/57 pts, the most ever/);
  assert.match(h.run('recordsBody({})'),/No emotes counted yet/);
});

test('settings follow a signed-in account, except this device\'s own',async()=>{
  const h=harness();
  // the account already has settings: this device takes them, but keeps its own turn alerts
  h.run('prefs.turnAlerts=true;session.account={id:1,unique_name:"me"};session.preferences={theme:"night",haptics:false,turnAlerts:false,unknown:1};syncPrefs()');
  assert.equal(h.run('prefs.theme'),'night');assert.equal(h.run('prefs.haptics'),false);
  assert.equal(h.run('prefs.turnAlerts'),true);assert.equal(h.run('"unknown" in prefs'),false);
  assert.equal(h.requests.length,0);
  // a change is sent to the account, without the device-only setting
  h.context.setTimeout=(run)=>{run();return 1;}; // the harness has no timers: save at once
  h.run('setPref("hideTips",true)');
  await new Promise((done)=>setImmediate(done));
  const sent=h.requests.at(-1);
  assert.equal(sent.url,'/golf/api/account/preferences');
  const body=JSON.parse(sent.options.body).preferences;
  assert.equal(body.hideTips,true);assert.equal(body.theme,'night');assert.equal('turnAlerts' in body,false);
  // a guest's settings stay on the device
  const g=harness();g.context.setTimeout=(run)=>{run();return 1;};g.run('session.account=null;setPref("hideTips",true)');
  await new Promise((done)=>setImmediate(done));
  assert.equal(g.requests.length,0);
});

test('void offer blocks actions and shows timed reply UI',async()=>{
  const h=harness();h.run('state={id:"room",viewer:1,names:["Alice","Bob"],void_offer:{by:0,expires_at:Date.now()/1000+30},game:{legal:{draw:true}},status:"playing"};renderVoidOffer();');
  assert.equal(h.nodes.get('void-dialog').open,true);
  assert.match(h.nodes.get('void-dialog').innerHTML,/data-void-reply="accept"/);
  assert.match(h.nodes.get('void-dialog').innerHTML,/Completed rounds are preserved/);
  assert.match(h.nodes.get('void-dialog').innerHTML,/NO RATING CHANGE/);
  assert.equal(h.run('actionAllowed("draw")'),false);assert.equal(await h.run('move("draw")'),false);
  assert.equal(h.requests.length,0);
  h.run('state.void_offer=null;renderVoidOffer()');assert.equal(h.nodes.get('void-dialog').open,false);
});

test('rated exit uses an in-game dialog with the MMR the server says it costs',async()=>{
  const h=harness();h.context.confirm=()=>{throw Error('Native popup used');};
  h.run('session.room_id="room";state={id:"room",rated:true,status:"playing",forfeit_mmr_loss:37}');
  const leaving=h.run('abandonExisting()');
  assert.equal(h.nodes.get('leave-dialog').open,true);
  assert.match(h.nodes.get('leave-dialog').innerHTML,/Leaving loses this game and the series, and costs you 37 MMR/);
  assert.equal(h.requests.length,0);
  h.run('resolveLeavePrompt("stay")');
  assert.equal(await leaving,false);
  assert.equal(h.requests.length,0);
});

test('between ranked games everyone is told that leaving loses the series, and what it costs',async()=>{
  for (const account of ['{id:1,unique_name:"me"}','null']) {
    const h=harness();h.context.confirm=()=>{throw Error('Native popup used');};
    h.run(`session.account=${account};session.room_id="room";state={id:"room",rated:true,status:"round_over",forfeit_mmr_loss:8,game:{phase:"over"}}`);
    const leaving=h.run('abandonExisting()');
    assert.match(h.nodes.get('leave-dialog').innerHTML,/Leaving loses the series and costs you 8 MMR\. Completed games are kept/);
    assert.equal(h.requests.length,0);
    h.run('resolveLeavePrompt("stay")');assert.equal(await leaving,false);
  }
});

test('leaving a tournament match warns that the opponent gets it',async()=>{
  const h=harness();
  h.run('session.room_id="room";state={id:"room",rated:false,tournament:{id:"t",match:"m"},status:"playing",game:{phase:"choose"}}');
  const leaving=h.run('abandonExisting()');
  assert.match(h.nodes.get('leave-dialog').innerHTML,/Leaving gives this tournament match to your opponent/);
  h.run('resolveLeavePrompt("stay")');assert.equal(await leaving,false);
});

test('guest exit offers sign-in, and No leaves through the API',async()=>{
  const h=harness();h.context.confirm=()=>{throw Error('Native popup used');};
  h.run('session.account=null;session.room_id="room";state={id:"room",practice:true,game:{phase:"choose"}}');
  const leaving=h.run('abandonExisting()');
  assert.match(h.nodes.get('leave-dialog').innerHTML,/Sign in to keep your streak/);
  assert.match(h.nodes.get('leave-dialog').innerHTML,/Save your streak by signing in, otherwise it will be lost\./);
  assert.match(h.nodes.get('leave-dialog').innerHTML,/data-leave-choice="leave">[^]*Leave<\/span>[^]*data-leave-choice="signin"/);
  assert.equal(h.requests.length,0);
  h.run('resolveLeavePrompt("leave")');
  assert.equal(await leaving,true);
  assert.equal(h.requests[0].url,'/golf/api/lobbies/room/leave');
});

test('Sign in goes straight to Google where it can, and says why where it cannot; there is no account page',async()=>{
  const h=harness();let said='';h.run('session.account=null');h.context.toastSaid=t=>{said=t;};h.run('toast=t=>toastSaid(t)');
  // ours to look at, with a place for Google's own button over it
  const button=h.run('signInButton("small c-p1","Sign in")');
  assert.match(button,/<span class="signin-wrap small c-p1"><button type="button" class="btn small c-p1" data-signin>Sign in<\/button><span class="google-cover" data-google-cover/);
  assert.match(h.run('youPaneHtml()'),/data-signin>.*Sign in<span class="sub">Keep your stats and add friends/);
  // no Google sign-in on this server: it says so
  await h.run('signIn()');assert.match(said,/not available on this server/);
  // at a table that is not a solo game of theirs: leave it first
  h.run('session.google_client_id="id";session.room_id="room";state=null');said='';
  await h.run('signIn()');assert.match(said,/Leave your current table/);assert.equal(h.run('canSignIn()'),false);
  h.run('session.room_id=null');assert.equal(h.run('canSignIn()'),true);
  // signed in: the button is the account's (its sheet has Sign out); a new account picks its unique name
  h.run('session.account={id:"1",unique_name:"ann"}');
  assert.match(h.run('youPaneHtml()'),/data-account-sheet>.*@ann<span class="sub">Your account/);assert.doesNotMatch(h.run('youPaneHtml()'),/data-signin/);
  h.run('accountSheet()');assert.match(h.nodes.get('sheet').innerHTML,/data-signout/);
  h.run('session.account={id:"1",unique_name:null}');assert.match(h.run('youPaneHtml()'),/data-unique-name>/);
  h.run('uniqueNameSheet()');assert.match(h.nodes.get('sheet').innerHTML,/id="account-name-form"/);
  assert.equal(h.run('typeof accountPage'),'undefined');
});

test('guest sign-in choice retains the table while starting sign-in',async()=>{
  const h=harness();h.run('session.account=null;session.room_id="room";state={id:"room",practice:true,game:{phase:"choose"}};signIn=()=>{globalThis.signinOpened=true;}');
  const leaving=h.run('abandonExisting()');
  h.run('resolveLeavePrompt("signin")');
  assert.equal(await leaving,false);
  assert.equal(h.context.signinOpened,true);
  assert.equal(h.run('session.room_id'),'room');
  assert.equal(h.requests.length,0);
});

test('every selectable rule has examples, hidden by default, with only necessary cards',()=>{
  const h=harness();const examples=h.run('RULE_EXAMPLES');assert.equal(Object.keys(examples).length,13);
  assert.equal(examples.royal_pairs[0][1].filter(Boolean).length,2);
  assert.equal(examples.roman_fives[0][1].filter(Boolean).length,3);
  assert.equal(examples.all_in_color[0][1].filter(Boolean).length,6);
  assert.equal(examples.angel_numbers[2][1].filter(Boolean).length,3);
  for(const key of Object.keys(examples)) {
    const html=h.run(`ruleHelpCard({key:${JSON.stringify(key)},name:"Rule",description:"Description"})`);
    assert.match(html,/aria-expanded="false"/);assert.match(html,/class="rule-example"[^>]* hidden/);
  }
});


test('rated labels show MMR, modifier totals come from each player, Practice alone shows flame',()=>{
  const h=harness();h.run(`board.el=document.createElement("div");board.view={opp:1};state={viewer:0,names:["Alice","Bot"],rated:true,ratings:[1234,1100],practice:false,connected:[true,true],rules:{},game:{phase:"turn",effect_totals:[8,10],scores:[8,10],effects:[[],[]],players:[[],[]],turn_order:[0,1],modifier_counts:[2,4],draw_count:20}};renderTags();`);
  assert.match(h.run(`board.el.querySelector("[data-score-for='me']").firstElementChild.innerHTML`),/Alice \(1234\)/);
  assert.match(h.run(`board.el.querySelector("[data-rules-for='opp']").querySelector(".txt").innerHTML`),/4 Rules/);
  assert.equal(h.run('board.el.querySelector("[data-practice-streak]").hidden'),true);
  h.run('state.rated=false;state.practice=true;state.streak={current:7,best:9,draws:1};renderTags()');
  assert.doesNotMatch(h.run(`board.el.querySelector("[data-score-for='me']").firstElementChild.innerHTML`),/1234/);
  assert.equal(h.run('board.el.querySelector("[data-practice-streak]").hidden'),false);
  assert.match(h.run('board.el.querySelector("[data-practice-streak]").innerHTML'),/class="digits streak-count" data-count="7"/);
});

test('tables of three mark who is up next on their score tag: yours, or that of the opponent showing',()=>{
  const h=harness();
  const game=(current,next)=>`{phase:"choose",current:${current},decision_player:${current},next_up:${next},legal:{flip:[]},effect_totals:[8,10,3],scores:[8,10,3],effects:[[],[],[]],players:[[],[],[]],turn_order:[0,1,2],modifier_counts:[0,0,0],draw_count:20}`;
  const label=`board.el.querySelector("[data-score-for='me']").querySelector("[data-turn-label]").textContent`;
  const aria=key=>h.run(`board.el.querySelector("${key}").attributes["aria-label"]`);
  h.run(`board.el=document.createElement("div");board.view={opp:1};state={viewer:0,status:"playing",names:["Alice","Bob","Cy"],connected:[true,true,true],rules:{},game:${game(2,0)}};renderTags();`);
  assert.equal(h.run(label),"Up next");assert.match(aria("[data-score-for='me']"),/Alice: 8 points, up next/);
  assert.doesNotMatch(aria("[data-score-for='opp']"),/up next/);assert.equal(aria('[data-cycle-next]'),"Show Cy's cards. Swipe to browse opponents.");
  // the button that turns to the next opponent carries no name of its own
  assert.doesNotMatch(h.run(`board.el.querySelector("[data-cycle-next]").querySelector(".cycle-ico").innerHTML`),/Cy/);
  h.run(`state.game=${game(0,1)};renderTags();`);
  assert.equal(h.run(label),"Your turn");assert.match(aria("[data-score-for='opp']"),/Bob: 10 points, up next/);
  h.run(`state.game=${game(1,2)};renderTags();`);
  // the opponent showing is the one playing: their tag says so, not "up next"
  assert.match(aria("[data-score-for='opp']"),/Bob: 10 points, their turn\./);
  assert.equal(h.run(`board.el.querySelector("[data-score-for='opp']").querySelector("[data-turn-label]").textContent`),"Their turn");
  // the next player is off screen until the table is turned to them
  h.run(`board.view={opp:2};renderTags();`);assert.match(aria("[data-score-for='opp']"),/Cy: 3 points, up next/);h.run(`board.view={opp:1};`);
  // a server that does not report who is next: the next seat in turn order, until someone goes out
  h.run(`state.game=${game(2,0)};delete state.game.next_up;renderTags();`);
  assert.equal(h.run(label),"Up next");assert.match(aria("[data-score-for='me']"),/up next/);
  h.run(`state.game.ending=true;renderTags();`);assert.doesNotMatch(aria("[data-score-for='me']"),/up next/);
  // the round ends with this turn, or it is a two-player table: nobody is next
  h.run(`state.game=${game(1,null)};board.view={opp:2};renderTags();`);assert.doesNotMatch(aria("[data-score-for='opp']"),/up next/);h.run(`board.view={opp:1};`);
  h.run(`state.names=["Alice","Bob"];state.game=${game(1,0)};state.game.turn_order=[0,1];renderTags();`);
  assert.doesNotMatch(aria("[data-score-for='me']"),/up next/);
});

test('the turn tooltip points up at the opponent on show when the turn is theirs, and down at the cycle button when it is not',()=>{
  const h=harness();
  h.run(`board.el=document.createElement("div");board.view={opp:1};prefs.hideTips=false;presenceState.queue=null;
    state={viewer:0,status:"playing",names:["Alice","Bob","Cy"],game:{phase:"choose",current:1,decision_player:1,final_turn:false,turn_order:[0,1,2],legal:{flip:[],guess:false,arrange:[]}}};
    board.el.querySelector("[data-actionbar]").querySelectorAll=()=>[];
    renderSummary=()=>{};renderModal=()=>{};renderEmotes=()=>{};placeCallout=()=>{};renderChrome();`);
  const callout=()=>h.run(`JSON.stringify([board.el.querySelector(".callout").textContent,board.el.querySelector(".callout").className,board.el.querySelector(".callout").dataset.anchor])`);
  assert.equal(callout(),JSON.stringify(["Bob's turn","callout c-s1 up","turn"]));
  const goto=()=>h.run('board.el.querySelector(".callout").dataset.goto ?? null');
  // pointing up at Bob, who is showing, there is nowhere to go
  h.run('board.el.isConnected=true;renderChrome()');assert.equal(goto(),null);
  h.run('board.view={opp:2};renderChrome()');assert.equal(callout(),JSON.stringify(["Bob's turn","callout c-s1 down","turn"]));
  // pointing down at the cycle button, a tap turns the table to Bob
  assert.equal(goto(),"1");
  assert.equal(h.run(`globalThis.went=[];cycleOpponent=(d)=>went.push(d);board.viewedOpponent=2;board.viewedTurn=state.id+":"+state.round+":"+state.game.turns+":"+state.game.current;goToOpponent(1);JSON.stringify(went)`),JSON.stringify([1]));
  h.run('state.game.final_turn=true;renderChrome()');assert.match(callout(),/Final turn · Bob's turn/);
  // your own turn is still announced beside your hand
  h.run('state.game.final_turn=false;state.game.current=state.game.decision_player=0;renderChrome()');assert.equal(callout(),JSON.stringify(["Your turn","callout c-p1 down",""]));
  assert.equal(goto(),null);
});

test('a reaction from a player who is off screen is a tooltip by the cycle button with their avatar and name in their color',()=>{
  const h=harness();
  h.run(`board.el=document.createElement("div");board.view={opp:1};state={viewer:0,status:"playing",names:["Alice","Bob","Cy <b>"],avatars:["dog","dog","dog"],game:{}};
    opponentEmotesMuted=false;activeEmotes={1:{id:"shocked",sequence:1,ends:Date.now()+4000},2:{id:"laughing",sequence:1,ends:Date.now()+4000}};renderEmotes();`);
  const others=h.run(`board.el.querySelector("[data-emote-others]").innerHTML`),beside=h.run(`board.el.querySelector("[data-emote-layer]").innerHTML`);
  assert.match(others,/class="player-emote other c-s2" data-emote-player="2"/);
  assert.match(others,/class="emote-who"><svg[^>]*class="ico"[\s\S]*<b>Cy &lt;b&gt;<\/b>/);assert.match(others,/emotes\/laughing\.png/);assert.doesNotMatch(others,/shocked/);
  // the opponent showing still reacts beside their own cards, with no label
  assert.match(beside,/class="player-emote them" data-emote-player="1"/);assert.doesNotMatch(beside,/emote-who|laughing/);
  h.run('opponentEmotesMuted=true;board.signatures={};renderEmotes();');
  assert.equal(h.run(`board.el.querySelector("[data-emote-others]").innerHTML`),'');
  // on the results, everyone's reaction sits above their own tile and nowhere else
  h.run(`opponentEmotesMuted=false;activeEmotes[0]={id:"nervous",sequence:1,ends:Date.now()+4000};
    globalThis.tiles=[0,1,2].map(p=>({dataset:{tileEmote:String(p)},innerHTML:""}));board.el.querySelectorAll=()=>tiles;renderEmotes();`);
  assert.match(h.run('tiles[0].innerHTML'),/class="player-emote tile" data-emote-player="0".*nervous\.png/);
  assert.match(h.run('tiles[1].innerHTML'),/shocked\.png/);assert.match(h.run('tiles[2].innerHTML'),/laughing\.png/);assert.doesNotMatch(h.run('tiles[2].innerHTML'),/emote-who/);
  assert.equal(h.run(`board.el.querySelector("[data-emote-others]").innerHTML`),'');assert.equal(h.run(`board.el.querySelector("[data-emote-layer]").innerHTML`),'');
});

test('controller bumpers take the cursor along with the avatar they choose when it rests on the wheel',()=>{
  const h=harness();
  h.run(`const item=(id,checked)=>({tagName:"BUTTON",id:"",dataset:{avatar:id},isConnected:true,attrs:{"aria-checked":String(checked)},
      matches:s=>s===".avatar",closest:()=>null,getAttribute(k){return this.attrs[k]??null;},setAttribute(k,v){this.attrs[k]=v;}});
    globalThis.wheelItems=[item("dog",true),item("frog",false),item("cat",false)];
    wheelItems.forEach((el,i)=>{el.previousElementSibling=wheelItems[i-1]||null;el.nextElementSibling=wheelItems[i+1]||null;});
    root.querySelector=sel=>sel.includes("aria-checked")?wheelItems.find(el=>el.attrs["aria-checked"]==="true"):null;
    root.querySelectorAll=()=>wheelItems;saveAvatar=()=>{};centerAvatar=()=>{};
    page="solo";PAD.scope={querySelectorAll:()=>[]};PAD.focus=wheelItems[0];padPress("rb");`);
  assert.equal(h.run('PAD.focus.dataset.avatar'),'frog');assert.equal(h.run('wheelItems[1].attrs["aria-checked"]'),'true');
  h.run('padPress("lb")');assert.equal(h.run('PAD.focus.dataset.avatar'),'dog');
  // at the end of the wheel nothing moves
  h.run('padPress("lb")');assert.equal(h.run('PAD.focus.dataset.avatar'),'dog');
  // from anywhere else the choice changes and the cursor stays where it is
  h.run(`globalThis.elsewhere={tagName:"BUTTON",dataset:{},matches:()=>false,closest:()=>null,getAttribute:()=>null};PAD.focus=elsewhere;padPress("rb");`);
  assert.equal(h.run('wheelItems[1].attrs["aria-checked"]'),'true');assert.equal(h.run('PAD.focus===elsewhere'),true);
});

test('Settings ends with the credit note and a link to the Figma designs',()=>{
  const h=harness();h.run('settingsSheet()');
  const html=h.nodes.get('sheet').innerHTML;
  assert.match(html,/This website has been programmed by Claude Fable 5\.2\. Front-end design was handmade in <a href="https:\/\/www\.figma\.com\/design\/OtrBljPuG5YggsJYThYGpq\/Golf\?node-id=114-91&amp;t=EDkY7LXjEWflPbP6-0" target="_blank" rel="noopener">Figma<svg[^>]*>.*?<\/svg><\/a> by Spencer\.<\/p>\s*<\/section>$/s);
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

test('the player popup lists that player\'s points for each finished game of a series and their sum',()=>{
  const h=harness();
  h.run('state={best_of:5,names:["Alice","Bob"],history:[{round:1,scores:[4,12],winner:0},{round:2,scores:[9,-3],winner:1}]}');
  const bob=h.run('seriesTally(1)');
  assert.match(bob,/Game 1<\/span><b>12 pts/);assert.match(bob,/Game 2<\/span><b>-3 pts/);
  // a best-of series counts wins; only a total-points series adds the points up
  assert.match(bob,/Wins<\/span><b>1 win</);assert.doesNotMatch(bob,/Total/);
  h.run('state.series_mode="points"');
  assert.match(h.run('seriesTally(1)'),/Total<\/span><b>9 pts/);
  assert.match(h.run('seriesTally(0)'),/Wins<\/span><b>1 win</);assert.match(h.run('seriesTally(0)'),/Total<\/span><b>13 pts/);
  h.run('state.history=[]');
  assert.match(h.run('seriesTally(1)'),/No games finished yet/);assert.match(h.run('seriesTally(1)'),/Wins<\/span><b>0 wins/);assert.match(h.run('seriesTally(1)'),/Total<\/span><b>0 pts/);
  // a single game has no tally, only what is being played
  h.run('state.best_of=1');assert.match(h.run('seriesTally(1)'),/Game 1 of 1<\/h3><div class="meta"><span class="pill">Single game<\/span>/);assert.doesNotMatch(h.run('seriesTally(1)'),/data-series-tally/);
  // a series says how it is decided, how long it runs, which game this is and its rules
  h.run('state.best_of=5;state.series_mode="wins";state.house_rules=true;state.status="playing";state.history=[]');
  assert.doesNotMatch(h.run('seriesTally(1)'),/class="pill">Game \d/);
  for(const text of ['<h3>Game 1 of 5</h3>','Best of','5 games · first to 3','House rules']) assert.match(h.run('seriesTally(1)'),new RegExp(text));
  h.run('state.best_of=null;state.house_rules=false;state.rules={v2:true,poison:true,king_queen:false}');
  for(const text of ['<h3>Game 1</h3>','Play until you leave','No set length','2 rules in play']) assert.match(h.run('seriesTally(1)'),new RegExp(text));
});

test('rows on the board open that player (the combined Guest row opens nothing), and times read as seconds',()=>{
  const h=harness();
  const html=h.run(`leaderboardBody("pvp",${JSON.stringify({pvp:[{id:'account:1',label:'@alice',mmr:1100,wins:1,draws:0,losses:0,win_rate:1},{id:'guests',label:'Guest',mmr:1000,wins:0,draws:0,losses:1,win_rate:0}]})})`);
  assert.match(html,/<button type="button" data-stats-player="account:1"/);assert.doesNotMatch(html,/data-stats-player="guests"/);
  assert.equal(h.run('statSeconds(8.42)'),'8.4 s');assert.equal(h.run('statSeconds(72)'),'1 min 12 s');assert.equal(h.run('statSeconds(null)'),'—');
  // a guest's own page is the browser's profile the server names, not their display name
  h.run('session={username:"Sam",player_id:"browser:abc"}');assert.equal(h.run('myPlayerId()'),'browser:abc');
  assert.equal(h.run('emoteNames.ofc'),'Ofc!');assert.ok(h.run('TEXT_EMOTES.includes("ofc")'));
});

test('a name tag at the table opens that player\'s profile in a sheet of their color, loading their profile and how they compare',()=>{
  const h=harness();const before=h.requests.length;
  h.run('state={id:"t",viewer:0,best_of:5,names:["Alice","Bob"],player_ids:["account:42","browser:abc"],seats:[1,2],history:[]};playerStatsSheet(1)');
  const html=h.nodes.get('sheet').innerHTML;
  assert.match(html,/class="sheet c-s1 profile-sheet"|class="sheet c-p2 profile-sheet"|class="sheet [a-z0-9-]+ profile-sheet"/);assert.match(html,/data-profile-sheet="browser:abc"/);
  assert.doesNotMatch(html,/Leaderboard|Advanced stats|Full stats|View stats/);
  const urls=h.requests.slice(before).map(r=>r.url);
  // (and the all-time records, the first time, to mark the ones they hold)
  assert.equal(urls.filter((url)=>!url.endsWith('/api/leaderboards')).length,2);assert.ok(urls.includes('/golf/api/profile?player=browser%3Aabc'));assert.ok(urls.some((url)=>url.startsWith('/golf/api/stats?player=browser%3Aabc')));
  // (a seat with no player id has only the table's own tally)
  const count=h.requests.length;h.run('state.player_ids=[null,null];playerStatsSheet(1)');
  assert.equal(h.requests.length,count);assert.match(h.nodes.get('sheet').innerHTML,/class="sheet [a-z0-9-]+ profile-sheet"/);
});
test('a profile shows who the player is, their numbers, how they compare with you, their bests with yours under them, and their flags',()=>{
  const h=harness();
  h.run('session.account={id:"me",unique_name:"spence"};session.avatar="dog"');
  const profile={id:'account:42',label:'Nathan',unique_name:'nathan',avatar:'dog',status:'offline',last_seen:Date.now()/1000-180,friend:'none',self:false,mmr:1320,provisional:false,pvp_streak:5,solo_streak:8,seconds_played:187200,
    personal:{highest_mmr:{mmr:1320,at:1},pvp_streak:{streak:5,at:2}},mine:{highest_mmr:{mmr:1210,at:3}}};
  const side=(label,unique,rounds)=>({profile:{id:label,label,unique_name:unique},overall:{rounds,round_win_rate:0.563,average_turns:11.3},ratings:{series:{rating:1146,rd:132,provisional:true}}});
  const html=h.run(`profileHtml(${JSON.stringify(profile)},${JSON.stringify({player:side('Nathan','nathan',668),comparison:side('You','spence',398)})})`);
  assert.match(html,/class="profile-name">Nathan<small>1,?320<\/small>/);assert.match(html,/@nathan · active 3m ago/);
  assert.match(html,/data-profile-friend="nathan"[^]*?Add friend/);
  for(const text of ['Current MMR','Solo Win Streak','PvP Win Streak','Time Played','Compare Players','Other Player','@nathan','@spence','Games played','Avg turns per game']) assert.match(html,new RegExp(text));
  assert.match(html,/aria-label="Their Records"/);assert.match(html,/Your best/);
  assert.match(html,/aria-label="Their Flags"/);
  // only the flags they have completed are shown, in their own color (none yet: a line says so)
  assert.doesNotMatch(html,/Adult swim/);assert.match(html,/hasn(&#39;|')t completed any flags yet/);
  const done=h.run(`profileHtml(${JSON.stringify({...profile,flags:["Let's go gambling!"]})},null,{accent:'c-s3'})`);
  assert.match(done,/class="panel c-s3 earned record-card flag-card"[^]*?Let(&#39;|')s go gambling!/);assert.doesNotMatch(done,/Adult swim|hourglass|flag-art/);
  // friends already: no button to press
  assert.match(h.run(`profileHtml(${JSON.stringify({...profile,friend:'friend'})},null)`),/disabled>[^]*?Friends/);
});
test('previous display names are one plain line of text, with no buttons',()=>{
  const h=harness();
  assert.equal(h.run('previousNamesHtml(["Ace","B & C","Dee"])'),'<p class="hint dark">Previously: Ace, B &amp; C, Dee</p>');
  assert.equal(h.run('previousNamesHtml([])'),'');
});

test('void action posts corrected lobby endpoint and reply payload',async()=>{
  const h=harness();h.run('state={id:"room"};session.room_id="room";accept=next=>{};');
  const click=h.listeners.click.at(-1);
  function event(dataset) { const button={disabled:false,dataset,matches:()=>false,classList:{contains:()=>false}};return {target:{closest:()=>button}}; }
  await click(event({voidOffer:''}));assert.equal(h.requests[0].url,'/golf/api/lobbies/room/void-offer');
  await click(event({voidReply:'accept'}));assert.equal(h.requests[1].url,'/golf/api/lobbies/room/void-reply');assert.deepEqual(JSON.parse(h.requests[1].options.body),{accept:true});
});

test('a signed-in player leaves an unfinished Practice game without a popup',async()=>{
  const h=harness();h.context.confirm=()=>{throw Error('Native popup used');};
  h.run('session.account={id:1,unique_name:"me"};session.room_id="room";state={id:"room",practice:true,game:{phase:"choose"}}');
  assert.equal(await h.run('abandonExisting()'),true);
  assert.equal(h.nodes.get('leave-dialog')?.open,undefined);
  assert.equal(h.requests[0].url,'/golf/api/lobbies/room/leave');
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
  const h=harness();h.run('board.el=document.createElement("div");board.view={opp:1};state={viewer:0,names:["Alice","Bot"],practice:true,streak:{current:0,best:0,draws:0},connected:[true,true],rules:{},game:{phase:"turn",effect_totals:[0,0],scores:[0,0],effects:[[],[]],players:[[],[]],turn_order:[0,1],modifier_counts:[0,0],draw_count:20}};renderTags()');
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
  assert.match(html,/K-Q <span class="pill rule-state active">active/);
  assert.equal(h.run('activeRules(1).length'),0);
  // a rule one swap away shows its chip on your own sheet, after the active ones
  h.run('state.game.near_rules=["holdem"]');
  const near=h.run('rulesSheet(0)');
  assert.match(near,/Hold em <span class="pill rule-state near">one move away/);
  assert.ok(near.indexOf('Show examples for K-Q')<near.indexOf('Show examples for Hold em'));
  assert.doesNotMatch(h.run('rulesSheet(1)'),/one move away/);
  // one move away sorts above every other rule (House or not), just below the active ones
  h.run('state.game.near_rules=["tricky_straights"];matchOptions.house_rules={holdem:true,king_queen:true}');
  const order=h.run('rulesSheet(0)');
  const at=(name)=>order.indexOf('Show examples for '+name);
  assert.ok(at('K-Q')<at('Straights')&&at('Straights')<at('Hold em'),'active, then one move away, then the rest');
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
  h.run('state.game.rule_previews[0]={angel_numbers:{indices:[],note:"Earned earlier; the row no longer needs to remain."}};');
  const html=h.run('ruleHelpCard({key:"angel_numbers",name:"Angel numbers",description:"Earned"},{player:0,on:true})');
  assert.match(html,/Earned earlier/);
  assert.equal((html.match(/example-card is-face/g)||[]).length,0);
  assert.match(html,/pill rule-state active">active/);
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

test('Solo shows best streak with W-D-L and win rate instead of current streak',()=>{
  const h=harness();
  h.run(`homeData.boards=${JSON.stringify({patch:'1.2.0',solo:[{label:'Alice',best_streak:8,current_streak:3,wins:6,draws:2,losses:2,win_rate:.6}]})};acesView="solo"`);
  const html=h.run('acesPaneHtml()');
  assert.match(html,/Solo Streaks/);
  assert.match(html,/best streak/);assert.match(html,/best streak 8/);
  assert.match(html,/W–D–L/);assert.match(html,/win rate/);
  assert.match(html,/6–2–2/);assert.match(html,/60%/);
  assert.doesNotMatch(html,/Current streak|Best reached/);
  // each row's current streak sits beside its best, small
  assert.match(html,/class="streak-now">currently 3</);
});

test('the modifiers bar counts points against the face value of the cards, and previews a staged move',()=>{
  const h=harness();
  const card=(points)=>`{visible:true,card:{points:${points}}}`;
  // a matched column of 8s and a 3: 19 on the cards, 3 on the score tag
  h.run(`board.el=document.createElement("div");board.view={opp:1};state={viewer:0,status:"playing",names:["Alice","Bot"],connected:[true,true],rules:{},game:{phase:"choose",current:0,decision_player:0,legal:{flip:[]},effect_totals:[3,12],scores:[3,12],effects:[["Column 1 pair: 0 (-16)"],[]],players:[[${card(8)},${card(3)},{visible:false,card:null},${card(8)}],[${card(10)},${card(2)}]],turn_order:[0,1],modifier_counts:[0,1],draw_count:20}};renderTags();`);
  const bar=side=>h.run(`board.el.querySelector("[data-rules-for='${side}']").querySelector(".txt").innerHTML`);
  assert.equal(bar('me'),'0 Rules in<br>play (-16pts)');assert.equal(bar('opp'),'1 Rule in<br>play (0pts)');
  assert.match(h.run(`board.el.querySelector("[data-rules-for='me']").attributes["aria-label"]`),/0 rules in play, -16 points against the cards' face value/);
  // a move waiting for Confirm: your bar reads as it would afterwards; theirs only if their score would change
  h.run(`board.staged={ready:true,movers:[],preview:{version:1,effect_totals:[9,12],modifier_counts:[2,1],face_values:[14,12],effects:[[],[]]}};renderTags();`);
  assert.equal(bar('me'),'<b class="new-score">New score: 9pts</b><br>2 Rules (-5pts)');assert.equal(bar('opp'),'1 Rule in<br>play (0pts)');
  h.run(`board.staged.preview.effect_totals=[9,15];board.staged.preview.face_values=[14,12];renderTags();`);
  assert.equal(bar('opp'),'<b class="new-score">New score: 15pts</b><br>1 Rule (+3pts)');
  // the score tags themselves already show the new scores
  const tag=side=>h.run(`board.el.querySelector("[data-score-for='${side}']").attributes["aria-label"]`);
  assert.match(tag('me'),/^Alice: 9 points once this move is confirmed/);assert.match(tag('opp'),/^Bot: 15 points once/);
  // going out on the staged move: the Poisoned Card it would bring leads the stickers
  h.run(`state.rules={poisoned_card:true};board.staged.preview.effects=[["Column 1 pair: 0 (-16)","Suited row 1: -3","Straight row 2: -4","Poisoned Card: +2"],[]];renderTags();`);
  assert.match(h.run(`board.signatures["rules-ico-me"]`),/^[^|]+\|flag\.pattern\.checkered:/);
  // called off: back to the table as it is
  h.run(`paintSelection=()=>{};cancelStaged();`);assert.match(tag('me'),/^Alice: 3 points,/);assert.equal(bar('me'),'0 Rules in<br>play (-16pts)');assert.equal(bar('opp'),'1 Rule in<br>play (0pts)');
});

test('a staged move can be confirmed at once, and asks the server what the score would be',async()=>{
  const h=harness();
  h.run(`paintSelection=()=>{};renderTags=()=>{globalThis.redrawn=true};prefs.confirm=true;state={id:"t1",version:7,status:"playing",viewer:0,game:{legal:{}}};playMove("swap",{index:2},{from:["discard",null],label:"swap"});`);
  assert.equal(h.run('board.staged.ready'),true);
  const sent=h.requests.at(-1);
  assert.equal(sent.url,'/golf/api/lobbies/t1/preview');assert.deepEqual(JSON.parse(sent.options.body),{action:'swap',version:7,index:2});
});

test('with a move staged, Enter confirms it even from a focused card, and Escape, Delete or Backspace undo it',()=>{
  const h=harness();
  h.run(`paintSelection=()=>{};renderTags=()=>{};prefs.confirm=true;state={id:"t1",version:7,status:"playing",viewer:0,game:{legal:{}}};playMove("swap",{index:2},{from:["discard",null],label:"swap"});
    page="room";globalThis.calls=[];confirmStaged=()=>calls.push("confirm");cancelStaged=()=>calls.push("undo");`);
  const keydown=h.listeners.keydown.at(-1);
  const press=(key,target={tagName:'BUTTON',closest:()=>null})=>{let prevented=false;keydown({key,target,repeat:false,preventDefault(){prevented=true;}});return prevented;};
  // focus is still on the card button that was just played
  assert.equal(press('Enter'),true);
  for(const key of ['Escape','Delete','Backspace']) assert.equal(press(key),true);
  assert.equal(h.run('JSON.stringify(calls)'),'["confirm","undo","undo","undo"]');
  // typing in a field keeps its own keys
  press('Backspace',{tagName:'INPUT',closest:()=>null});press('Enter',{tagName:'INPUT',closest:()=>null});
  assert.equal(h.run('JSON.stringify(calls)'),'["confirm","undo","undo","undo"]');
});

test('a double-tap flips whatever else has happened at the table, and waits its turn behind a move in flight',async()=>{
  const h=harness();
  h.run(`state={id:"t1",version:7,status:"playing",viewer:0,game:{phase:"setup",legal:{flip:[1,4],draw:false}}};board.lastTap={ref:[0,1],time:performance.now()};`);
  assert.equal(h.run('secondTap([0,1])'),true);assert.equal(h.run('secondTap([0,4])'),false);
  // someone else's flip arriving between the two taps changes the version, nothing more
  h.run('state.version=8;');assert.equal(h.run('secondTap([0,1])'),true);
  h.run('board.lastTap.time-=DOUBLE_TAP_MS+50;');assert.equal(h.run('secondTap([0,1])'),false);
  h.run('state.game.legal.flip=[4];board.lastTap={ref:[0,1],time:performance.now()};');assert.equal(h.run('secondTap([0,1])'),false);
  // asked for while another move is still out: kept, then sent once that one has landed
  const before=h.requests.length;
  h.run('busy=true;flipMove([0,4]);');
  assert.equal(h.requests.length,before);assert.deepEqual(h.run('JSON.stringify(board.queuedFlip)'),'[0,4]');
  h.run('busy=false;drainFlip();');
  assert.equal(h.run('board.queuedFlip'),null);
  const sent=h.requests.at(-1);
  assert.equal(sent.url,'/golf/api/lobbies/t1/action');assert.deepEqual(JSON.parse(sent.options.body),{action:'flip',version:8,index:4});
  // no longer legal by the time its turn comes: dropped, not sent
  const count=h.requests.length;h.run('busy=true;flipMove([0,4]);state.game.legal.flip=[];busy=false;drainFlip();');
  assert.equal(h.requests.length,count);assert.equal(h.run('board.queuedFlip'),null);
});

test('settings offer the Original, Poker, Night Golf, Pool and Focus themes on their own sheet, and the choice re-skins the page',()=>{
  // Focus is a flag's to unlock (Black out!): listed, locked, and a saved choice of it can't be picked
  const plain=harness();
  assert.doesNotMatch(plain.run('themeListHtml()'),/data-theme-pick="focus"/);
  assert.match(plain.run('themeListHtml()'),/Earn &quot;Black out!&quot;/);
  plain.run('pickTheme("focus")');assert.equal(plain.run('prefs.theme'),'golf');
  const h=harness();
  // Settings names the theme in use on a row that opens the themes' sheet (no longer a switch that cycles them)
  h.run('settingsSheet()');
  assert.match(h.nodes.get('sheet').innerHTML,/<button type="button" class="btn c-fw pref" data-theme-settings>[^]*?<span class="grow">Theme<\/span><b class="pref-value on">Original<\/b>/);
  assert.doesNotMatch(h.nodes.get('sheet').innerHTML,/data-pref="theme"/);
  assert.equal(h.run('document.documentElement.dataset.theme'),undefined);
  // the sheet lists each theme with a preview, the one in use checked
  // (Poker and Pool are a flag's to unlock: locked, they are listed but can't be picked)
  h.run('themeSheet()');
  let sheet=h.nodes.get('sheet').innerHTML;
  assert.match(sheet,/class="theme-choice locked"[^>]*aria-disabled="true"[^]*?<span class="grow"><small class="theme-flag">Earn &quot;Let(&#39;|')s go gambling!&quot;/);
  assert.doesNotMatch(sheet,/>Poker<|>Pool<|Poker,|Pool,/);
  assert.doesNotMatch(sheet,/data-theme-pick="poker"/);
  h.run('pickTheme("poker")');assert.equal(h.run('prefs.theme'),'golf');
  h.run('myFlags.themes=["poker","pool","focus","night"]');h.run('themeSheet()');sheet=h.nodes.get('sheet').innerHTML;
  assert.match(sheet,/aria-label="Theme"/);assert.equal(sheet.match(/class="theme-swatches"/g).length,5);assert.equal(sheet.match(/class="ts-(p1|p2|p3|p4|text|bg)"/g).length,30);
  for(const [key,name] of [['golf','Original'],['poker','Poker'],['night','Night Golf'],['focus','Focus']])
    assert.match(sheet,new RegExp(`role="radio" aria-checked="${key==='golf'}" data-theme-pick="${key}"[^]*?<span class="grow">${name}</span>`));
  for(const [key,name] of [['poker','Poker'],['night','Night Golf'],['focus','Focus'],['golf','Original']]){
    h.run(`pickTheme("${key}")`);
    assert.equal(h.run('prefs.theme'),key);assert.equal(h.run('document.documentElement.dataset.theme'),key==='golf'?undefined:key);
    assert.match(h.run('themeListHtml()'),new RegExp(`aria-checked="true" data-theme-pick="${key}"`));
    assert.equal(h.run('themeListHtml()').match(/aria-checked="true"/g).length,1);
    h.run('settingsSheet()');assert.match(h.nodes.get('sheet').innerHTML,new RegExp(`<b class="pref-value on">${name}</b>`));
  }
  // every theme the settings offer has its tokens in the stylesheet
  const css=fs.readFileSync(path.join(__dirname,'style.css'),'utf8');
  for(const [key] of JSON.parse(h.run('JSON.stringify(THEMES)')).slice(1)) assert.match(css,new RegExp(`:root\\[data-theme="${key}"\\] \\{`));
});

/* ---------- patch 1.4.0 ---------- */
test('at a table of three or more, a tag counts down to its turn: Up in 3, Up in 2, Up next',()=>{
  const h=harness();
  const game=(current,next,waits)=>`{phase:"choose",current:${current},decision_player:${current},next_up:${next},up_in:${JSON.stringify(waits)},legal:{flip:[]},effect_totals:[8,10,3,4],scores:[8,10,3,4],effects:[[],[],[],[]],players:[[],[],[],[]],turn_order:[0,1,2,3],modifier_counts:[0,0,0,0],draw_count:20}`;
  const label=side=>h.run(`board.el.querySelector("[data-score-for='${side}']").querySelector("[data-turn-label]").textContent`);
  const aria=side=>h.run(`board.el.querySelector("[data-score-for='${side}']").attributes["aria-label"]`);
  h.run(`board.el=document.createElement("div");board.view={opp:2};state={viewer:0,status:"playing",names:["Alice","Bob","Cy","Di"],connected:[true,true,true,true],rules:{},game:${game(1,2,[3,null,1,2])}};renderTags();`);
  assert.equal(label('me'),'Up in 3');assert.match(aria('me'),/Alice: 8 points, up in 3 turns/);
  assert.equal(label('opp'),'Up next');
  h.run(`state.game=${game(2,3,[2,3,null,1])};renderTags();`);
  assert.equal(label('me'),'Up in 2');
  h.run(`state.game=${game(3,0,[1,2,3,null])};renderTags();`);
  assert.equal(label('me'),'Up next');
  // a two-player table never counts down
  h.run(`board.view={opp:1};state={viewer:0,status:"playing",names:["Alice","Bob"],connected:[true,true],rules:{},game:{phase:"choose",current:1,decision_player:1,up_in:[1,null],legal:{flip:[]},effect_totals:[8,10],scores:[8,10],effects:[[],[]],players:[[],[]],turn_order:[0,1],modifier_counts:[0,0],draw_count:20}};`);
  assert.equal(h.run('turnsUntil(0)'),null);
});

test('solo results have two graphs, a table between people keeps all three',()=>{
  const h=harness();
  h.run('state={solo:true,timeline:[{},{},{}],history:[{scores:[1,2]},{scores:[3,4]}]}');
  assert.deepEqual([...h.run('chartViews()')],['game','series']);
  h.run('state.solo=false');
  assert.deepEqual([...h.run('chartViews()')],['game','games','series']);
});

test('the records added in 1.4.0 each have a card',()=>{
  const h=harness();
  const html=h.run(`recordsBody({always_in_play:["Poisoned Card"],comeback_modifier:{name:"V2",wins:9},
    ai_vs_players:{id:"bot:golfbot",label:"Golfbot",bot_points:25673,player_points:24846,games:2173},
    luck:{id:"account:1",label:"Ann",first:14,games:21,rate:2/3},
    gospel:{id:"account:2",label:"bob",count:5},
    spectacle:{count:4,players:["Ann","Bob <b>"],scores:[14,6],label:"Bob"},
    recruit:{id:"account:3",label:"Lily",at:Date.now()/1000-3*86400},
    upset:{id:"account:2",label:"Bob",opponent:"Ann",gap:230,ratings:[950,1180],points:[14,6],winner:1}})`);
  assert.match(html,/CPU vs\. all players/);assert.match(html,/Golfbot<\/strong><\/p><p>is behind everyone put together: 25,673 pts to the players' 24,846 over 2,173 games/);
  assert.match(html,/Luck of the draw/);assert.doesNotMatch(html,/988|1012/);assert.match(html,/Ann<\/strong><\/p><p>gets to go first 66\.7% of the time \(14 of 21 games\)… because of course they do!/);
  assert.match(html,/Spreading the gospel/);assert.match(html,/through invite links/);
  assert.match(html,/Quite the spectacle/);assert.match(html,/Ann vs Bob &lt;b&gt;<\/strong> finished 14 to 6/);
  assert.match(html,/Newest recruit/);assert.match(html,/Lily<\/strong><\/p><p>is the newest Golf account/);assert.match(html,/days ago/);
  assert.match(html,/David vs\. Goliath/);assert.match(html,/Bob<\/strong><\/p><p>\(950\) won a series against Ann \(1,180\), 6 to 14/);
  // the comeback modifier says what it leaves out
  assert.match(html,/in the most comeback wins<\/p><p class="record-note">Leaves out Poisoned Card\./);
  assert.match(html,/Highest MMR/);assert.doesNotMatch(html,/Elo/);
  // Golfbot's own card lists the record it holds
  assert.equal(h.run(`recordCards({ai_vs_players:{id:"bot:golfbot",label:"Golfbot",bot_points:1,player_points:2,games:1}}).filter(({record})=>record&&record.id==="bot:golfbot").length`),1);
});

test('advanced stats show both ratings and the first-turn rows',()=>{
  const h=harness();
  const stats='{rounds:10,round_wins:6,round_losses:3,round_draws:1,round_win_rate:.6,match_wins:1,match_losses:0,match_draws:0,match_win_rate:1,average_points:5,average_opponent_points:7,average_advantage:-2,total_points:50,best_round:-2,worst_round:20,known_turn_games:10,known_first_games:8,first_games:5,first_rate:.625,first_wins:4,first_win_rate:.8,later_games:3,later_wins:1,later_win_rate:1/3,rule_activations:[]}';
  const html=h.run(`statsTable([{profile:{label:"@ann"},ratings:{series:{rating:1162,rd:290,provisional:true,wins:1,draws:0,losses:0},game:{rating:1081,rd:240,provisional:true,wins:3,draws:0,losses:2}},overall:${stats}}],"overall","Overall","c-p3")`);
  assert.match(html,/MMR \(series rating\)/);assert.match(html,/1,162\? <small>±290 · 1–0–0<\/small>/);
  assert.match(html,/Game rating/);assert.match(html,/1,081\?/);
  assert.match(html,/Went first<\/th><td>62\.5% <small>\(5 of 8\)<\/small>/);
  assert.match(html,/Win rate going first<\/th><td>80% <small>\(4 of 5\)/);
  assert.match(html,/Win rate not going first<\/th><td>33\.3% <small>\(1 of 3\)/);
  assert.doesNotMatch(html,/recorded since patch 1\.4\.0/);
  // (the rule activations are a card of their own, after the stats)
  assert.match(html,/<\/section><section class="panel [^"]*rule-activations stats-card"><h2>Rule Activations[^<]*<\/h2>/);assert.doesNotMatch(html,/View rule activation|no activation records|Indented rows/);
  // head to head has no ratings rows: they belong to the player, not the pairing
  assert.doesNotMatch(h.run(`statsTable([{profile:{label:"@ann"},ratings:{series:{rating:1,rd:1,wins:0,draws:0,losses:0},game:{rating:1,rd:1,wins:0,draws:0,losses:0}},head_to_head:${stats}}],"head_to_head","Head to head","c-p1")`),/MMR/);
});

test('Host a Table offers Solo, which starts a custom match against Golfbot',async()=>{
  const h=harness();h.run('enterRoom = next => { globalThis.entered = next; }; saveAvatar("frog"); startSetup("host")');
  assert.match(h.nodes.get('app').innerHTML,/<option value="solo"[^>]*>Solo<\/option>/);
  h.run('draft.gameType="solo";draft.style="points";draft.length=3;setupPage()');
  const page=h.nodes.get('app').innerHTML;
  assert.match(page,/Just you against Golfbot/);assert.doesNotMatch(page,/Spectator Odds/);
  await h.run('submitSetup()');
  const sent=h.requests.at(-1);
  assert.equal(sent.url,'/golf/api/solo');
  const body=JSON.parse(sent.options.body);
  assert.equal(body.practice,false);assert.equal(body.game_type,'1v1');assert.equal(body.best_of,3);assert.equal(body.series_mode,'points');
});

test('Watch shows tournaments being played as cards of their own, then PvP and Solo games (a tournament\'s matches only in its card)',async()=>{
  const h=harness();
  h.context.fetch=async(url)=>({ok:true,json:async()=>url.includes('/api/tournaments')
    ?[{id:'t1',name:'Friday Cup',status:'live',format_name:'Single elimination',ranked:true,entrants:4,live:2,host:'Ann',champion:null,mine:false},
      {id:'t2',name:'Open one',status:'open',format_name:'Round robin',ranked:false,entrants:1,live:0,host:'Bob',champion:null,mine:false}]
    :[{id:'g1',names:['Ann','Golfbot'],scores:[3,9],points:[20,30],wins:[2,1],avatars:[],solo:true,round:4,best_of:null,watchers:0,started_at:Date.now()/1000-600},
      {id:'g2',names:['Cy','Di'],scores:[1,2],points:[0,0],wins:[0,0],avatars:[],mmr:[1100,null],solo:false,round:1,best_of:5,series_mode:'points',watchers:3,rated:true,tournament:{id:'t1',name:'Friday Cup',label:'Semifinal'}},
      {id:'g3',names:['Eve <i>','Flo'],scores:[4,4],points:[0,0],wins:[1,0],avatars:[],solo:false,round:2,best_of:3,series_mode:'wins',watchers:1},
      {id:'g4',names:['Me','Golfbot'],scores:[0,0],solo:true,round:1,best_of:null,mine:true}]});
  await h.run('loadTab("watch")');
  const html=h.run('watchPaneHtml()');
  assert.match(html,/data-watch="g1"/);assert.doesNotMatch(html,/data-watch="g2"/);assert.match(html,/data-watch="g3"/);assert.doesNotMatch(html,/data-watch="g4"/);
  assert.match(html,/Eve &lt;i&gt;/);
  // PvP first, then Solo
  assert.ok(html.indexOf('PvP Games')<html.indexOf('data-watch="g3"')&&html.indexOf('Solo Games')<html.indexOf('data-watch="g1"'));
  // each card says which game of the series it is, how long ago it began, and who is watching
  assert.match(html,/Game 2 of 3 · Best of/);assert.match(html,/Game 4<\/span>/);
  assert.match(html,/10m ago/);assert.match(html,/1 spectating now/);assert.match(html,/Tap to spectate!/);
  // a tournament: its format and size, its matches in play
  assert.match(html,/Tournaments/);assert.match(html,/data-tournament-open="t1"/);assert.match(html,/4-players/);assert.match(html,/2 matches in play/);assert.doesNotMatch(html,/Open one/);
});

test('Match history has the same three lists, with finished tournaments under Tournaments',async()=>{
  const h=harness();
  const saved=(id,name,extra={})=>({id,lobby_name:name,names:['Ann','Bob'],solo:false,best_of:1,series_mode:'wins',status:'finished',winner:0,wins:[1,0],points:[3,9],
    rounds:[{round:1,scores:[3,9],winner:0,ended_at:1700000000}],viewer:null,patch:'1.4.0',...extra});
  h.context.fetch=async(url)=>{h.requests.push({url});return {ok:true,json:async()=>url.includes('/api/tournament-history')
    ?[{id:'t9',name:'Old Cup',status:'finished',format_name:'Round robin',ranked:false,entrants:3,live:0,host:'Ann',champion:'Bob <b>',finished_at:1700000000,mine:true}]
    :{matches:[saved('m1',url.includes('kind=tournament')?'Old Cup: Final':url.includes('kind=solo')?'Solo table':'Friendly Golf')],next_offset:null}};};
  h.run('page="home"');h.run('historyPage()');
  await h.run('Promise.all(LIST_TABS.map(item=>loadHistoryList(item.key)))');
  // (one page, laid out as the home screen is, with the home screen's bar at its foot)
  assert.match(h.nodes.get('app').innerHTML,/class="tab-btn c-p2 on" data-list-tab="pvp" aria-current="page"/);
  assert.ok(h.requests.some(r=>r.url.endsWith('/api/history?kind=pvp&offset=0')));
  let html=h.run('historyPaneHtml("pvp")');
  assert.match(html,/Friendly Golf/);assert.match(html,/games between players/);
  assert.doesNotMatch(html,/data-tournament-open/);
  assert.match(h.run('historyPaneHtml("solo")'),/Solo table/);assert.ok(h.requests.some(r=>r.url.endsWith('/api/history?kind=solo&offset=0')));
  html=h.run('historyPaneHtml("tournament")');
  assert.ok(h.requests.some(r=>r.url.endsWith('/api/tournament-history')));
  assert.match(html,/data-tournament-open="t9"/);assert.match(html,/Round robin · 3 players · [^<]* · Bob &lt;b&gt; won/);
  assert.match(html,/aria-label="Tournament Matches"/);assert.match(html,/Old Cup: Final/);
});

test('the notes of a new patch pop up once, with an x and Start golfing!',async()=>{
  const h=harness();
  const stored={'golf-played-patch':'1.3.0'};
  h.context.localStorage.getItem=key=>stored[key]??null;h.context.localStorage.setItem=(key,value)=>{stored[key]=value;};
  h.context.fetch=async()=>({ok:true,json:async()=>({current:'1.4.0',patches:[{version:'1.4.0',labels:{changes:"What's new"},rules:{revisions:[],additions:[]},changes:['Tournaments! <b>']},{version:'1.3.0',rules:{revisions:[],additions:[]},changes:['Old news']}]})});
  h.run('session.patch="1.4.0";session.account=null;page="home"');
  await h.run('patchPopup()');
  // (a sheet, like Settings)
  const sheet=()=>h.nodes.get('sheet');
  assert.equal(sheet().hidden,false);
  assert.match(sheet().innerHTML,/class="sheet c-fw patch-sheet"/);
  assert.match(sheet().innerHTML,/class="close-btn" data-patch-close/);
  assert.match(sheet().innerHTML,/Patch 1\.4\.0/);assert.match(sheet().innerHTML,/Tournaments! &lt;b&gt;/);assert.doesNotMatch(sheet().innerHTML,/Old news/);
  assert.match(sheet().innerHTML,/data-patch-close>[^]*Start golfing!/);
  h.run('closePatchPopup()');assert.equal(sheet().hidden,true);
  // seen on this patch (closing it says so): it does not come back
  assert.equal(stored['golf-played-patch'],'1.4.0');
  h.run('patchPopupDone=false');
  await h.run('patchPopup()');assert.equal(sheet().hidden,true);
  // and a first visit has nothing to catch up on
  const fresh=harness();fresh.run('session.patch="1.4.0";page="home"');await fresh.run('patchPopup()');
  assert.equal(fresh.nodes.get('sheet').hidden,true);
});

test('a patch can sort its notes under headings of its own',()=>{
  const h=harness();
  const html=h.run(`patchNotesHtml(${JSON.stringify({version:'1.4.0',rules:{revisions:[],additions:[]},changes:[],
    sections:[{title:'Tournaments',notes:['Host one <b>','Invite players']},{title:'Ranked & more',notes:['Glicko-2']},{title:'Empty',notes:[]}]})})`);
  assert.match(html,/<h3[^>]*>Tournaments<\/h3><p>• Host one &lt;b&gt;<\/p><p>• Invite players<\/p><h3[^>]*>Ranked &amp; more<\/h3><p>• Glicko-2<\/p>/);
  assert.doesNotMatch(html,/Empty|Play and interface/);
  // older patches, with one list, read as before
  assert.match(h.run(`patchNotesHtml({rules:{revisions:[],additions:[]},changes:['Old news']})`),/Play and interface<\/h3><p>• Old news/);
});

test('Host a Tournament sends the format, seeding, fill and ranked choices with the match settings',async()=>{
  const h=harness();h.run('saveAvatar("frog");tournamentPage = id => { globalThis.opened = id; }; startSetup("tournament")');
  let page=h.nodes.get('app').innerHTML;
  assert.match(page,/Host a Tournament/);assert.match(page,/Lose once and you(&#39;|')re eliminated\./);
  assert.match(page,/Single elimination/);assert.match(page,/Double elimination/);assert.match(page,/Round robin/);
  assert.match(page,/Score Preview/);assert.match(page,/Spectator Odds/);
  assert.doesNotMatch(page,/Play until you leave/);  // every match-up needs an end
  // one game is a length, not a style; and Match Style sits right under Format
  assert.doesNotMatch(page,/Single game/);assert.match(page,/<option value="1" selected>1 game<\/option>/);
  assert.match(page,/Every match-up: one game\./);
  assert.ok(page.indexOf('Tournament format')<page.indexOf('Match style')&&page.indexOf('Match style')<page.indexOf('aria-label="Seeding"'));
  assert.equal(h.run('draft.style'),'wins');assert.equal(h.run('draft.length'),1);
  h.run('draft.format="round_robin";draft.fill="ai";draft.seeding="mmr";draft.ranked="on";draft.tournamentName="Friday Cup";draft.style="wins";draft.length=3;setupPage()');
  page=h.nodes.get('app').innerHTML;
  assert.match(page,/Everyone plays everyone once\./);assert.match(page,/a CPU opponent joins so nobody sits out/);
  assert.match(page,/count toward MMR, and are played on House rules/);
  h.context.fetch=async(url,options)=>{h.requests.push({url,options});return {ok:true,json:async()=>({id:'cup1',name:'Friday Cup'})};};
  await h.run('submitSetup()');
  const sent=h.requests.at(-1);
  assert.equal(sent.url,'/golf/api/tournaments');
  const body=JSON.parse(sent.options.body);
  assert.deepEqual([body.name,body.format,body.seeding,body.fill,body.ranked,body.best_of,body.series_mode,body.house_rules],['Friday Cup','round_robin','mmr','ai',true,3,'wins',true]);
  assert.equal(h.run('globalThis.opened'),'cup1');
});

test('the tournament page is a lobby before the start and a bracket with standings after',()=>{
  const h=harness();h.run('centerAvatar=()=>{}');  // the avatar wheel needs a real page to scroll
  const entrants=[{id:'e1',name:'Ann',avatar:'a',ai:false,seed:1,rating:1100,withdrawn:false,out:false},{id:'e2',name:'Bob <b>',avatar:'a',ai:false,seed:2,rating:1000,withdrawn:false,out:false},
    {id:'e3',name:'Golfbot',avatar:'a',ai:true,seed:3,rating:1000,withdrawn:false,out:true},{id:'e4',name:'Cy',avatar:'a',ai:false,seed:4,rating:900,withdrawn:false,out:false}];
  const base={id:'cup1',name:'Friday Cup',format:'single',format_name:'Single elimination',seeding:'mmr',fill:'ai',ranked:true,capacity:32,host:'e1',champion:null,
    settings:{best_of:1,series_mode:'wins',house_rules:true,rules:{}},sitting_out:{},standings:[]};
  h.run(`page="tournament";tournament=${JSON.stringify({...base,status:'open',can_start:true,entrants:entrants.slice(0,3),matches:[],you:{entrant:'e1',host:true,match:null,room_id:null}})};renderTournament()`);
  let html=h.nodes.get('app').innerHTML;
  assert.match(html,/Friday Cup/);assert.match(html,/Single elimination/);assert.match(html,/Seeded by MMR/);assert.match(html,/Ranked/);
  assert.match(html,/data-tournament-start/);assert.match(html,/data-tournament-remove="e3"/);
  // the host's buttons are a table host's: Invite a Player above Start, and Back closes the tournament
  assert.ok(html.indexOf('data-invite-open')>0&&html.indexOf('data-invite-open')<html.indexOf('data-tournament-start'));
  assert.match(html,/back-btn" data-tournament-leave/);assert.doesNotMatch(html,/data-tournament-ai|Add AI|Cancel/);
  assert.match(html,/Bob &lt;b&gt;/);assert.match(html,/CPU opponent/);assert.match(html,/tournament\/cup1/);
  // someone who has not joined sees Join, and no host controls
  h.run(`tournament.you={entrant:null,host:false,match:null,room_id:null};renderTournament()`);
  html=h.nodes.get('app').innerHTML;
  assert.match(html,/data-tournament-join/);assert.doesNotMatch(html,/data-tournament-start|data-tournament-remove|data-invite-open/);
  assert.match(html,/back-btn" data-nav="friends"/);
  const matches=[{id:'W1-1',bracket:'W',round:1,index:1,label:'Semifinal',players:['e1','e4'],status:'live',winner:null,score:null,note:null,room_id:'r1',live:{game:1,wins:[0,0],points:[0,0],scores:[3,7],watchers:2}},
    {id:'W1-2',bracket:'W',round:1,index:2,label:'Semifinal',players:['e2','e3'],status:'done',winner:0,score:[1,0],note:null,room_id:'r2'},
    {id:'W2-1',bracket:'W',round:2,index:1,label:'Final',players:[null,'e2'],status:'pending',winner:null,score:null,note:null,room_id:null}];
  const standings=[{id:'e2',wins:1,draws:0,losses:0,points:4},{id:'e1',wins:0,draws:0,losses:0,points:0},{id:'e4',wins:0,draws:0,losses:0,points:0},{id:'e3',wins:0,draws:0,losses:1,points:9}];
  h.run(`tournament=${JSON.stringify({...base,status:'live',can_start:false,entrants,matches,standings,you:{entrant:'e4',host:false,match:'W1-1',room_id:'r1'}})};renderTournament()`);
  html=h.nodes.get('app').innerHTML;
  assert.match(html,/Your match is on/);assert.match(html,/data-tournament-play="r1"/);
  // the matches in play are in the bracket (its live cards open them), with no list or title of their own
  assert.doesNotMatch(html,/<h[12][^>]*aria-label="Matches in Play"/);assert.doesNotMatch(html,/<h[12][^>]*aria-label="Bracket"/);
  // each player in the standings opens their profile
  assert.match(html,/<button type="button" data-stats-player="[^"]+" aria-label="[^"]+'s profile" class="st-player/);
  // the bracket: a column a round, each match a card in the colors of where it has got to
  assert.match(html,/class="bracket-round" aria-label="Semifinal"/);assert.match(html,/class="bracket-round" aria-label="Final"/);
  assert.match(html,/To be decided/);assert.match(html,/bk-player c-s\d won/);assert.match(html,/bk-trophy/);
  assert.match(html,/Match finished/);assert.match(html,/Still Seeding/);
  // standings: a card with each player's record and where they stand
  assert.match(html,/Standings/);assert.match(html,/standings-card/);assert.match(html,/>Out<\/span>/);
  assert.doesNotMatch(html,/Host tools/);  // only the host can award a match
  // a spectator of the same tournament can watch the live match
  h.run(`tournament.you={entrant:null,host:false,match:null,room_id:null};renderTournament()`);
  assert.match(h.nodes.get('app').innerHTML,/class="bk-match boxed c-s4 live" data-match="[^"]+" data-watch="r1"/);assert.match(h.nodes.get('app').innerHTML,/2 spectating now/);
  // finished: the champion is named
  h.run(`tournament.status="finished";tournament.champion="e2";tournament.matches.forEach(m=>{m.status="done";m.winner=m.winner??1;delete m.live;});renderTournament()`);
  assert.match(h.nodes.get('app').innerHTML,/cup-won[^>]*>.*Bob &lt;b&gt;<span class="sub">Wins the Tournament!<\/span>/);
});

test('a tournament host invites players as a table host does, and the invitation says what it is to',async()=>{
  const h=harness();
  h.run('page="tournament";tournament={id:"cup1",status:"open",you:{host:true}}');
  assert.equal(h.run('hostedLobby().id'),'cup1');
  h.context.fetch=async(url,options)=>{h.requests.push({url,options});return {ok:true,json:async()=>({sent:true,players:[],invitations:[],invited:[]})};};
  await h.listeners.click.at(-1)({target:{closest:()=>({dataset:{invitePlayer:'p7'},disabled:false,matches:()=>false,classList:{contains:()=>false}})},preventDefault(){}});
  assert.ok(h.requests.some(r=>r.url==='/golf/api/tournaments/cup1/invite'&&JSON.parse(r.options.body).player_id==='p7'));
  h.run('tournament.status="live"');assert.equal(h.run('hostedLobby()'),null);
  h.nodes.set('invite-banner',h.context.document.createElement());h.run('globalThis.reducedMotion={matches:true}');
  h.run('renderInvitePill({id:"i1",host:"Ann",tournament:{id:"cup1",name:"Friday Cup",format_name:"Double elimination",ranked:true,best_of:3,series_mode:"wins",house_rules:true}})');
  const pill=h.nodes.get('invite-banner').innerHTML;
  assert.match(pill,/Tournament invite!/);assert.match(pill,/Ann · Friday Cup/);assert.match(pill,/Double elimination · /);assert.match(pill,/Ranked/);
  // (and home no longer has a pill for the tournament you are in)
  assert.equal(h.run('typeof tournamentChip'),'undefined');
});

test('a player card shows every record they are part of; Golfbot\'s only its records',async()=>{
  const h=harness();
  const records={longest_pvp:{turns:41,players:['Ann','Bob'],ids:['account:7','account:8'],id:'account:8',label:'Bob',scores:[9,4],at:1700000000}};
  // the name-tag popup: Ann did not win the longest game, but she played it, so it is on her card
  const holder=Object.assign(h.context.document.createElement(),{dataset:{playerCard:'account:7'}});
  h.context.document.querySelectorAll=()=>[holder];
  h.context.fetch=async()=>({ok:true,json:async()=>({id:'account:7',mmr:null,pvp_streak:2,seconds_played:60,records})});
  await h.run('loadPlayerCard("account:7")');
  assert.match(holder.innerHTML,/Records held/);assert.match(holder.innerHTML,/Longest 1v1 game/);assert.match(holder.innerHTML,/Best PvP win streak/);
  // Golfbot's card has only its records
  const bot=Object.assign(h.context.document.createElement(),{dataset:{playerCard:'bot:golfbot'}});
  h.context.document.querySelectorAll=()=>[bot];
  h.context.fetch=async()=>({ok:true,json:async()=>({id:'bot:golfbot',mmr:null,pvp_streak:0,seconds_played:0,records:{ai_vs_players:{id:'bot:golfbot',label:'Golfbot',bot_points:10,player_points:20,games:3}}})});
  await h.run('loadPlayerCard("bot:golfbot")');
  assert.match(bot.innerHTML,/CPU vs\. all players/);assert.doesNotMatch(bot.innerHTML,/Best PvP win streak/);
});

test('the home screen has five tabs, Play in the middle; the one showing is lifted with arrows to its neighbors',()=>{
  const h=harness();
  const bar=h.run('tabBarHtml("play")');
  assert.deepEqual([...bar.matchAll(/data-home-tab="(\w+)"/g)].map(m=>m[1]),['flags','you','play','watch','aces']);
  assert.match(bar,/class="tab-btn c-p3 on" data-home-tab="play" aria-current="page"/);
  // the first tab has no way further left
  const first=h.run('tabBarHtml("flags")');
  assert.match(first,/class="tab-arrow prev c-p4 off" data-home-step="-1" aria-label="Previous tab" disabled>/);assert.match(first,/class="tab-arrow next c-p4" data-home-step="1" aria-label="Next tab">/);
  // one pair of arrows for the whole bar, in the colors of the tab showing
  assert.equal(bar.match(/class="tab-arrow /g).length,2);assert.match(bar,/class="tab-arrow prev c-p3" data-home-step="-1"/);
  assert.equal(h.run('tabPath("watch")'),'/watch');h.run('acesView="pvp"');assert.equal(h.run('tabPath("aces")'),'/aces/pvp');
  // Start a Game opens on the four ways to play
  h.run('startOpen=true');const start=h.run('startGameHtml()');
  for(const way of ['data-nav="friends"','data-queue-toggle','data-nav="solo"','data-nav="rules"']) assert.ok(start.includes(way),way);
  assert.match(start,/aria-expanded="true"/);assert.match(start,/Close/);
});

test('the Daily Puzzle shows its starting hand, every score fetched in a scrolling list, and your best',()=>{
  const h=harness();
  const card=(label,suit)=>({visible:true,card:{label,suit,rank:1,points:1}});const down={visible:false,card:null};
  h.run(`homeData.puzzle=${JSON.stringify({number:7,hand:[down,down,card('10','H'),down,card('6','C'),down],players:6,best:-3,rank:2,
    board:[{name:'Ann <b>',avatar:'dog',score:-9,mine:false},{name:'Me',avatar:'cat',score:-3,mine:true},{name:'C',score:1},{name:'D',score:2},{name:'E',score:3}]})}`);
  const html=h.run('puzzleHtml()');
  assert.match(html,/Daily Puzzle #7/);
  assert.equal(html.match(/example-card is-face/g).length,2);assert.equal(html.match(/class="pb-row/g).length,5);
  assert.match(html,/Ann &lt;b&gt;/);
  // your own row has the star before your name; nobody else's does
  assert.match(html,/<span class="pb-name"><svg class="[^"]*you-star[^"]*"[^]*?<\/svg>Me<\/span>/);assert.equal(html.match(/you-star/g).length,1);assert.match(html,/<div class="pb-scroll" data-pb-list><div class="pb-list">/);assert.doesNotMatch(html,/view more/);assert.match(html,/<p class="tab-sub">Your best: -3 · #2 · can you do better\?<\/p>/);assert.doesNotMatch(html,/class="sub"/);
  h.run('homeData.puzzle.best=null;homeData.puzzle.board=[];homeData.puzzle.players=0');
  const fresh=h.run('puzzleHtml()');assert.match(fresh,/<p class="tab-sub">In 5 moves, get the biggest margin vs PuzzleBot<\/p>/);assert.match(fresh,/<div class="pb-list empty"><p class="pb-empty">No scores yet/);
});

test('Friends: a guest is asked to sign in; friends show what they are up to, with a way to watch a game',()=>{
  const h=harness();
  h.run('homeData.friends={signed_in:false,friends:[],incoming:[],outgoing:[]}');
  assert.match(h.run('friendsHtml()'),/Sign in to add friends/);
  const now=Math.floor(Date.now()/1000);
  h.run(`homeData.friends=${JSON.stringify({signed_in:true,incoming:[{unique_name:'zed',display_name:'Zed'}],outgoing:[],friends:[
    {unique_name:'ann',display_name:'Ann',status:'in_game',room_id:'r1',mmr:1038},
    {unique_name:'bo',display_name:'Bo',status:'puzzle'},{unique_name:'cy',display_name:'Cy',status:'online'},
    {unique_name:'di',display_name:'Di',status:'offline',last_seen:now-7200},{unique_name:'ed',display_name:'Ed',status:'offline',last_seen:null}]})}`);
  const html=h.run('friendsHtml()');
  assert.match(html,/data-watch="r1" aria-label="Watch Ann"/);assert.match(html,/1,038/);
  for(const text of ['In-game','Solving the puzzle','Online','Active 2h ago','Offline','Friend requests \\(1\\)']) assert.match(html,new RegExp(text));
});

test('Flags: each flag is locked for now, with what it would unlock; You has the emote editor in one Emote Bar box',()=>{
  const h=harness();
  const flags=h.run('flagsPaneHtml()');
  assert.equal(flags.match(/class="panel c-fw record-card flag-card"/g).length,h.run('FLAGS.length'));assert.equal(flags.match(/class="record-slot c-fw"/g).length,h.run('FLAGS.length'));assert.match(flags,/<h3>Wait for my cue\.\.\.<\/h3>/);assert.doesNotMatch(flags,/5, 6, 7/);assert.match(flags,/Adult swim/);assert.match(flags,/<p class="record-note">Text Emote<\/p>/);assert.match(flags,/<p class="record-note">Theme<\/p>/);assert.doesNotMatch(flags,/Rushing\.|Theme: Pool/);
  assert.equal(flags.match(/Not earned yet/g).length,h.run('FLAGS.length'));
  const edit=h.run('emoteEditHtml()');
  assert.match(edit,/class="emote-compact"/);assert.match(edit,/Emote Bar/);assert.match(edit,/Unequipped Emotes/);
  assert.match(edit,/class="emote-choices bar faces" data-kind="faces"/);assert.match(edit,/class="emote-choices bar words" data-kind="words"/);
  // (the newer faces are hidden for now: every face there is to pick is on the bar)
  assert.match(edit,/Every emote is on your bar\./);assert.doesNotMatch(edit,/pogcat|crocscreech/);
  h.run('dropEmote("faces","nervous")');assert.match(h.run('emoteEditHtml()'),/class="emote-choices faces" data-kind="faces"[^>]*><span class="emote-none"><\/span><span class="emote-item" data-emote-item="faces:nervous"/);
});

test('dates within the last 24 hours read as how long ago',()=>{
  const h=harness();const now=Math.floor(Date.now()/1000);
  const label=ago=>h.run(`dateLabel(${now-ago})`);
  assert.equal(label(1),'1 second ago');assert.equal(label(45),'45 seconds ago');
  assert.equal(label(60),'1 min ago');assert.equal(label(59*60+59),'59 mins ago');
  assert.equal(label(3600),'1 hour ago');assert.equal(label(86400),'24 hours ago');
  assert.equal(label(86401+3600),new Date((now-86401-3600)*1000).toLocaleDateString());
});

test('the emote bar shows the emotes chosen in Settings > Emotes, in their order, with the sayings in two rows',()=>{
  const h=harness();const bar=kind=>h.run(`emoteBar("${kind}").join()`);
  // (What a save! is a secret flag's to unlock: off the bar until it is earned)
  assert.equal(bar('words'),'luck,thanks,oops,wow,ofc,tempo');assert.ok(h.run('!flagUnlocked("word","save") && !flagUnlocked("word","ranked")'));
  h.run('myFlags.emotes=["save","ranked"]');
  assert.equal(h.run('emoteNames.ranked'),'Join Ranked!');assert.ok(h.run('TEXT_EMOTES.includes("ranked")'));
  // every face there is to pick starts on the bar (the newer faces are hidden for now, and
  // Heart is the Cupid's porcelain throne flag's: held back until it is earned)
  assert.equal(h.run('FACE_EMOTES.join()'),'unamused,shocked,laughing,cackling,nervous,pogcat,giveheart,crocscreech,poop');
  assert.equal(bar('faces'),'unamused,shocked,laughing,cackling,nervous');assert.ok(h.run('!flagUnlocked("word","giveheart")'));
  assert.doesNotMatch(h.run('emoteEditHtml()'),/giveheart/);
  // (every one, that is, but those a flag holds back: Rushing. and Dragging. until earned)
  assert.equal(bar('words'),'luck,thanks,oops,wow,save,ofc,tempo,ranked');assert.ok(h.run('!flagUnlocked("word","rushing") && flagUnlocked("word","luck")'));
  h.run('state={status:"playing"}');
  let html=h.run('emoteButtons()');
  assert.equal(html.match(/data-emote="/g).length,13);
  // the sayings in two rows: the first half over the rest
  const rows=html=>[...html.matchAll(/<div class="emote-words-row">(.*?)<\/div>/g)].map(row=>[...row[1].matchAll(/data-emote="(\w+)"/g)].map(m=>m[1]).join());
  assert.deepEqual(rows(html),['luck,thanks,oops,wow','save,ofc,tempo,ranked']);
  assert.doesNotMatch(h.run('emoteEditHtml()'),/aria-label="Add /); // none left off
  // on the bar: a tap chooses (and shows the x that takes it off), a tap on another trades places
  h.run('pickEmote("words","ranked")');assert.equal(bar('words'),'luck,thanks,oops,wow,save,ofc,tempo,ranked');
  html=h.run('emoteEditHtml()');
  assert.match(html,/data-emote-pick="words:ranked" aria-pressed="true"/);assert.match(html,/data-emote-drop="words:ranked" aria-label="Take Join Ranked! off your bar"/);
  assert.equal(html.match(/data-emote-drop=/g).length,1);
  h.run('pickEmote("words","luck")');assert.equal(bar('words'),'ranked,thanks,oops,wow,save,ofc,tempo,luck');
  assert.doesNotMatch(h.run('emoteEditHtml()'),/data-emote-drop=|aria-pressed="true"/);
  // a second tap on the chosen one lets it go; one chosen of the other kind trades nothing
  h.run('pickEmote("faces","shocked");pickEmote("faces","shocked");pickEmote("faces","unamused");pickEmote("words","oops");pickEmote("words","wow")');
  assert.equal(bar('faces'),'unamused,shocked,laughing,cackling,nervous');assert.equal(bar('words'),'ranked,thanks,wow,oops,save,ofc,tempo,luck');
  // taken off, an emote leaves the bar (an odd number puts the extra saying in the top row); one left off joins the end with a tap
  h.run('dropEmote("faces","cackling");dropEmote("words","save");dropEmote("words","ofc");dropEmote("words","tempo")');
  assert.equal(bar('faces'),'unamused,shocked,laughing,nervous');assert.equal(bar('words'),'ranked,thanks,wow,oops,luck');
  html=h.run('emoteButtons()');assert.doesNotMatch(html,/cackling/);assert.deepEqual(rows(html),['ranked,thanks,wow','oops,luck']);
  assert.match(h.run('emoteEditHtml()'),/data-emote-pick="words:tempo"  aria-label="Add Not my tempo\. to your bar"/);
  h.run('pickEmote("words","tempo")');assert.equal(bar('words'),'ranked,thanks,wow,oops,luck,tempo');
  // one saying has one row; a kind can be emptied, and then has no row on the bar
  h.run('prefs.emoteWords="wow"');assert.deepEqual(rows(h.run('emoteButtons()')),['wow']);
  h.run('dropEmote("words","wow")');assert.equal(bar('words'),'');assert.equal(h.run('prefs.emoteWords'),'');
  html=h.run('emoteButtons()');assert.doesNotMatch(html,/emote-words/);assert.match(html,/data-emote-mute/);
  assert.doesNotMatch(h.run('emoteEditHtml()'),/data-emote-pick="words:[a-z]+" aria-pressed/); // none on it
  // the editor lives on the You tab alone: Settings has no way into it
  assert.doesNotMatch(h.run('prefsHtml()'),/emote/i);assert.match(h.run('youPaneHtml()'),/data-emote-edit/);
  // a saved bar with a name it doesn't know, or one twice, keeps the rest
  h.run('prefs.emoteWords="ranked,nope,ranked,luck"');assert.equal(bar('words'),'ranked,luck');
});

test('an emote added to the game later starts off the bar, for a new player and for one with a saved bar',()=>{
  const fresh=harness();fresh.run('myFlags.emotes=["save","ranked"]');
  fresh.run('TEXT_EMOTES.push("later");emoteNames.later="Later!";FACE_EMOTES.push("smug");emoteNames.smug="Smug"');
  assert.equal(fresh.run('emoteBar("words").join()'),'luck,thanks,oops,wow,save,ofc,tempo,ranked');
  assert.equal(fresh.run('emoteBar("faces").join()'),'unamused,shocked,laughing,cackling,nervous');
  const edit=fresh.run('emoteEditHtml()');
  assert.match(edit,/aria-label="Add Later! to your bar"/);assert.match(edit,/aria-label="Add Smug to your bar"/);
  fresh.run('state={status:"playing"}');assert.doesNotMatch(fresh.run('emoteButtons()'),/data-emote="(later|smug)"/);
  fresh.run('prefs.emoteWords="wow,luck"');assert.equal(fresh.run('emoteBar("words").join()'),'wow,luck');
  fresh.run('pickEmote("words","later")');assert.equal(fresh.run('emoteBar("words").join()'),'wow,luck,later');
  // the bar that started with five sayings (for a short while) was never a choice: it becomes every saying
  assert.equal(fresh.run('unchosenEmotes({emoteWords:"luck,thanks,oops,wow,save",theme:"night"}).emoteWords'),undefined);
  assert.equal(fresh.run('unchosenEmotes({emoteWords:"luck,thanks,oops,wow"}).emoteWords'),'luck,thanks,oops,wow');
  const h=harness();
  h.run('session.account={id:1,unique_name:"me"};session.preferences={emoteWords:"luck,thanks,oops,wow,save",emoteFaces:"nervous"};syncPrefs()');
  assert.equal(h.run('prefs.emoteWords'),'luck,thanks,oops,wow,save,ofc,tempo,ranked');assert.equal(h.run('prefs.emoteFaces'),'nervous');
});
test('Settings has a Reduce motion switch, off unless chosen',()=>{
  const h=harness();
  assert.match(h.run('prefsHtml()'),/aria-checked="false" data-pref="reduceMotion"[^]*?Reduce motion[^]*?>Off</);
  h.run('prefs.reduceMotion=true');
  assert.match(h.run('prefsHtml()'),/aria-checked="true" data-pref="reduceMotion"[^]*?Reduce motion[^]*?>On</);
});
test('the Play tab\'s matches show what a Ranked series did to each player\'s MMR',()=>{
  const h=harness();
  assert.match(h.run('mmrChange(12)'),/class="mh-delta up"[^>]*>\+12 MMR</);assert.match(h.run('mmrChange(-9)'),/class="mh-delta down"[^>]*>−9 MMR</);
  assert.equal(h.run('mmrChange(0)'),'');assert.equal(h.run('mmrChange(undefined)'),'');
  h.run(`homeData.matches=[{id:'m',names:['Ann','Bo'],avatars:['dog','cat'],viewer:0,winner:1,points:[20,9],wins:[0,1],mmr:[988,1012],rounds:[{round:1,scores:[20,9],winner:1,ended_at:1,mmr:[{delta:-12},{delta:12}]}],updated_at:1,house_rules:true}]`);
  const html=h.run('matchesHtml()');
  assert.doesNotMatch(html,/988|1012/);assert.match(html,/Ann<\/b><span class="mh-delta down"[^>]*>−12 MMR</);
  assert.match(html,/mh-player won[^]*?Bo<\/b><span class="mh-delta up"[^>]*>\+12 MMR</);
});
test('every match on the Match history page is drawn as a whole card, not only the first',()=>{
  const h=harness();
  const match=(id)=>({id,lobby_name:'Table '+id,names:['Ann','Bo'],viewer:0,winner:0,points:[3,9],wins:[1,0],status:'finished',rounds:[{round:1,scores:[3,9],winner:0,ended_at:1}],updated_at:1});
  const html=h.run(`${JSON.stringify([match('a'),match('b'),match('c')])}.map((match) => matchArticleHtml(match)).join("")`);
  assert.equal((html.match(/<article class="panel c-fw">/g)||[]).length,3);assert.equal((html.match(/class="meta"/g)||[]).length,3);
});

test('the results leaderboard ranks each player, tied margins sharing a place, and more rows load after the first',()=>{
  const h=harness();
  const board=[{name:'Ann',score:9,id:'browser:a'},{name:'Bo',score:5,id:'account:b'},{name:'Cy',score:5,id:'browser:c'},{name:'Di',score:1}];
  const ranked=h.run(`puzzleRowsHtml({board:${JSON.stringify(board)}},30,{ranked:true})`);
  assert.deepEqual([...ranked.matchAll(/<span class="pb-rank">(\d+)<\/span>/g)].map((m)=>m[1]),['1','2','2','4']);
  assert.equal((ranked.match(/data-stats-player=/g)||[]).length,3);
  // (the home card's list has no places; a page of more rows is only the new ones)
  assert.doesNotMatch(h.run(`puzzleRowsHtml({board:${JSON.stringify(board)}})`),/pb-rank/);
  const more=h.run(`puzzleRowsHtml({board:${JSON.stringify(board)}},19,{from:2})`);
  assert.deepEqual([...more.matchAll(/<span class="pb-name">([^<]*)/g)].map((m)=>m[1]),['Cy','Di']);
});
