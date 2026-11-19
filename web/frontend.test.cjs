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

// The leaderboard page is drawn once; each view then lands in its body, under the header and tabs.
const leaderHtml=h=>{const app=h.nodes.get('app');return app.innerHTML+app.querySelector('[data-leader-shell]').querySelector('[data-leader-body]').innerHTML;};
test('leaderboard defaults PVP, escapes names, formats fractional win rate',async()=>{
  const h=harness();await h.run('leaderboardPage()');
  const html=leaderHtml(h);
  assert.match(html,/data-leader-tab="pvp" aria-pressed="true"/);
  // the leader's card and a ranked row for each player, with Elo and W–D–L
  assert.match(html,/class="panel c-p3 stat-hero leader-hero"/);assert.match(html,/class="list-item board-row c-p3"/);
  assert.match(html,/1,210<small>Elo<\/small>/);assert.match(html,/3–1–2/);assert.match(html,/W–D–L/);
  assert.match(html,/Alice &lt;admin&gt;/);assert.match(html,/50%/);
  assert.equal(h.requests[0].url,'/golf/api/leaderboards');
  await h.run('leaderboardPage("solo")');assert.match(leaderHtml(h),/No solo streaks yet/);assert.doesNotMatch(leaderHtml(h),/Best reached/);
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

test('between ranked games a signed-in player leaves without a popup; a guest is still told',async()=>{
  const h=harness();h.context.confirm=()=>{throw Error('Native popup used');};
  h.run('session.account={id:1,unique_name:"me"};session.room_id="room";state={id:"room",rated:true,status:"round_over",game:{phase:"over"}}');
  assert.equal(await h.run('abandonExisting()'),true);
  assert.equal(h.nodes.get('leave-dialog')?.open,undefined);
  assert.equal(h.requests.at(-1).url,'/golf/api/lobbies/room/leave');
  h.run('session.account=null;session.room_id="room"');
  const leaving=h.run('abandonExisting()');
  assert.match(h.nodes.get('leave-dialog').innerHTML,/This ends the series early/);
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


test('rated labels use Elo, modifier totals come from each player, Practice alone shows flame',()=>{
  const h=harness();h.run(`board.el=document.createElement("div");board.view={opp:1};state={viewer:0,names:["Alice","Bot"],rated:true,ratings:[1234,1100],practice:false,connected:[true,true],rules:{},game:{phase:"turn",effect_totals:[8,10],scores:[8,10],effects:[[],[]],players:[[],[]],turn_order:[0,1],modifier_counts:[2,4],draw_count:20}};renderTags();`);
  assert.match(h.run(`board.el.querySelector("[data-score-for='me']").firstElementChild.innerHTML`),/Alice \(1234\)/);
  assert.match(h.run(`board.el.querySelector("[data-rules-for='opp']").querySelector(".txt").innerHTML`),/4 Modifiers/);
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
  h.run('state.best_of=1');assert.equal(h.run('seriesTally(1)'),'');
});

test('the ranking shows guests as one row that opens no player page, and times read as seconds',()=>{
  const h=harness();
  const row=(id,label,rounds)=>({profile:{id,label},rounds,round_wins:1,round_losses:0,round_draws:0,round_win_rate:1});
  const html=h.run(`leaderboardHtml(${JSON.stringify({leaderboard:[row('account:1','@alice',2),row('guests','Guest',5)]})})`);
  assert.match(html,/<button type="button" data-stats-player="account:1"/);
  assert.match(html,/<div class="list-item board-row c-fw" aria-label="2\. Guest/);assert.doesNotMatch(html,/data-stats-player="guests"/);
  assert.equal(h.run('statSeconds(8.42)'),'8.4 s');assert.equal(h.run('statSeconds(72)'),'1 min 12 s');assert.equal(h.run('statSeconds(null)'),'—');
  // a guest's own page is the browser's profile the server names, not their display name
  h.run('session={username:"Sam",player_id:"browser:abc"}');assert.equal(h.run('myPlayerId()'),'browser:abc');
  assert.equal(h.run('emoteNames.ofc'),'Ofc!');assert.ok(h.run('TEXT_EMOTES.includes("ofc")'));
});

test('the player popup has one View stats button for that player, and loads only their player card',()=>{
  const h=harness();const before=h.requests.length;
  h.run('state={id:"t",viewer:0,best_of:5,names:["Alice","Bob"],player_ids:["account:42","browser:abc"],seats:[1,2],history:[]};playerStatsSheet(1)');
  const html=h.nodes.get('sheet').innerHTML;
  assert.match(html,/data-stats-player="browser:abc">[\s\S]*View stats<\/button>/);
  assert.doesNotMatch(html,/Leaderboard|Advanced stats|Full stats|Loading stats/);
  assert.deepEqual(h.requests.slice(before).map(r=>r.url),['/golf/api/player-card?player=browser%3Aabc']);
  h.run('state.player_ids=[null,null];playerStatsSheet(1)');
  assert.match(h.nodes.get('sheet').innerHTML,/data-nav="stats">[\s\S]*View stats<\/button>/);
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

test('Solo shows best streak with W-D-L and win rate instead of current streak',async()=>{
  const h=harness();h.context.fetch=async()=>({ok:true,json:async()=>({patch:'1.2.0',solo:[{label:'Alice',best_streak:8,current_streak:3,wins:6,draws:2,losses:2,win_rate:.6}]})});
  await h.run('leaderboardPage("solo")');
  assert.match(h.nodes.get('app').innerHTML,/data-leader-shell/);
  const html=leaderHtml(h);
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
  assert.equal(bar('me'),'0 Modifiers in<br>play (-16pts)');assert.equal(bar('opp'),'1 Modifier in<br>play (0pts)');
  assert.match(h.run(`board.el.querySelector("[data-rules-for='me']").attributes["aria-label"]`),/0 modifiers in play, -16 points against the cards' face value/);
  // a move waiting for Confirm: your bar reads as it would afterwards; theirs only if their score would change
  h.run(`board.staged={ready:true,movers:[],preview:{version:1,effect_totals:[9,12],modifier_counts:[2,1],face_values:[14,12],effects:[[],[]]}};renderTags();`);
  assert.equal(bar('me'),'<b class="new-score">New score: 9pts</b><br>2 Modifiers (-5pts)');assert.equal(bar('opp'),'1 Modifier in<br>play (0pts)');
  h.run(`board.staged.preview.effect_totals=[9,15];board.staged.preview.face_values=[14,12];renderTags();`);
  assert.equal(bar('opp'),'<b class="new-score">New score: 15pts</b><br>1 Modifier (+3pts)');
  // the score tags themselves already show the new scores
  const tag=side=>h.run(`board.el.querySelector("[data-score-for='${side}']").attributes["aria-label"]`);
  assert.match(tag('me'),/^Alice: 9 points once this move is confirmed/);assert.match(tag('opp'),/^Bot: 15 points once/);
  // going out on the staged move: the Poisoned Card it would bring leads the stickers
  h.run(`state.rules={poisoned_card:true};board.staged.preview.effects=[["Column 1 pair: 0 (-16)","Suited row 1: -3","Straight row 2: -4","Poisoned Card: +2"],[]];renderTags();`);
  assert.match(h.run(`board.signatures["rules-ico-me"]`),/^[^|]+\|flag\.pattern\.checkered:/);
  // called off: back to the table as it is
  h.run(`paintSelection=()=>{};cancelStaged();`);assert.match(tag('me'),/^Alice: 3 points,/);assert.equal(bar('me'),'0 Modifiers in<br>play (-16pts)');assert.equal(bar('opp'),'1 Modifier in<br>play (0pts)');
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

test('settings offer the Original, Poker and Night Golf themes, and the choice re-skins the page',()=>{
  const h=harness();
  h.run('settingsSheet()');
  assert.match(h.nodes.get('sheet').innerHTML,/data-pref="theme"[^]*?<span class="grow">Theme<\/span><b class="pref-value on">Original<\/b>/);
  assert.equal(h.run('document.documentElement.dataset.theme'),undefined);
  h.run('togglePref("theme")');
  assert.equal(h.run('prefs.theme'),'poker');assert.equal(h.run('document.documentElement.dataset.theme'),'poker');
  h.run('settingsSheet()');assert.match(h.nodes.get('sheet').innerHTML,/<b class="pref-value on">Poker<\/b>/);
  h.run('togglePref("theme")');
  assert.equal(h.run('prefs.theme'),'night');assert.equal(h.run('document.documentElement.dataset.theme'),'night');
  h.run('settingsSheet()');assert.match(h.nodes.get('sheet').innerHTML,/<b class="pref-value on">Night Golf<\/b>/);
  h.run('togglePref("theme")');
  assert.equal(h.run('prefs.theme'),'golf');assert.equal(h.run('document.documentElement.dataset.theme'),undefined);
  // every theme the settings offer has its tokens in the stylesheet
  const css=fs.readFileSync(path.join(__dirname,'style.css'),'utf8');
  for(const [key] of JSON.parse(h.run('JSON.stringify(THEMES)')).slice(1)) assert.match(css,new RegExp(`:root\\[data-theme="${key}"\\] \\{`));
});
