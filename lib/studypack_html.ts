/**
 * Render a study pack to a self-contained, interactive HTML file — the Study Pack
 * Build Kit's own template and engine (initQuiz / initFlash / accordions / tabs),
 * filled with the generated content. One file, no external assets, works offline
 * in any browser, exactly as the Build Kit requires. The LOTS crest, colours and
 * footer credit are kept; the "Template Guide" tab is not emitted.
 *
 * This is the *working* artefact — a study pack must be interactive (non-negotiable
 * 4), which a PDF cannot be. The printable PDF is a separate render (slice 2).
 *
 * All generated text is HTML-escaped; the content data goes to the engine as a
 * JSON island with </script> neutralised, so a stray tag or brace in a key idea
 * can never break the page.
 */
import type { PackContent } from './studypack';
import { CREST } from './crest';

const esc = (s: string) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const json = (v: unknown) =>
  JSON.stringify(v).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');

interface Meta { subject: string; yearGroup: string; weekFrom: number; weekTo: number; }

export function renderStudyPackHtml(pack: PackContent, meta: Meta): string {
  const unitTabs = pack.units.map((u, i) =>
    `<button class="nav-btn" data-tab="unit${i}" onclick="showTab('unit${i}')">${esc(u.unit_label)}</button>`).join('');

  const unitSections = pack.units.map((u, ui) => `
  <section id="tab-unit${ui}" class="tab-panel unit${ui % 2 === 0 ? 1 : 2}">
    <div class="unit-banner"><h2>${esc(u.unit_label)}</h2><p>${esc(u.summary)}</p></div>
    ${u.topics.map((t, ti) => `
    <div class="accordion">
      <div class="acc-header" onclick="toggleAcc(this)"><span>${esc(t.topic_label)}</span><span class="chev">&#9662;</span></div>
      <div class="acc-body"><div class="acc-content">
        <div class="objective-tag">${t.objectives.map(o => esc((o.ref ? o.ref + ' — ' : '') + o.text)).join(' · ') || 'Objectives stated in prose'}</div>
        <div class="key-ideas"><h4>Key ideas</h4><ul>${t.key_ideas.map(k => `<li>${esc(k)}</li>`).join('')}</ul></div>
        ${t.quiz.length ? `<div class="interactive-block"><h5>&#10067; Quick quiz</h5><div id="quiz-${ui}-${ti}"></div></div>` : ''}
        <div class="think-block"><h5>&#129504; Think further</h5><p>${esc(t.think_question)}</p></div>
      </div></div>
    </div>`).join('')}
  </section>`).join('');

  // Revision zone: glossary flashcards + a mixed quiz of one question per topic.
  const mixedQuiz = pack.units.flatMap(u => u.topics.flatMap(t => t.quiz.slice(0, 1)));
  const quizData: Record<string, unknown> = {};
  pack.units.forEach((u, ui) => u.topics.forEach((t, ti) => { if (t.quiz.length) quizData[`quiz-${ui}-${ti}`] = t.quiz; }));

  const objectivePills = [...new Set(pack.objective_refs)].map(r => `<span class="pill">${esc(r)}</span>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(pack.title)} — LOTS Study Pack</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,600;9..144,700&family=Public+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  :root{
    --forest:#1D5829; --forest-dark:#103C19; --forest-light:#31773F; --gold:#E3A73B; --gold-dark:#B8860B;
    --purple:#4D27A5; --pink:#EC4899; --teal:#0D9488; --teal-dark:#0F766E; --blue:#194AB3; --green:#16A34A; --red:#DC2626;
    --ink:#26302A; --paper:#FFFDF8; --card:#FFFFFF; --muted:#657064; --line:#D9DED2; --shadow:0 6px 18px rgba(23,41,28,0.10);
    --font-display:'Fraunces',Georgia,serif; --font-body:'Public Sans','Segoe UI',sans-serif;
  }
  *{box-sizing:border-box;}
  @media (prefers-reduced-motion:reduce){*{animation-duration:.01ms!important;transition-duration:.01ms!important;}}
  body{margin:0;font-family:var(--font-body);background:radial-gradient(circle at 10% 0%,#eaf3ec 0%,transparent 40%),radial-gradient(circle at 90% 10%,#fdf3e0 0%,transparent 40%),var(--paper);color:var(--ink);line-height:1.5;padding-bottom:60px;}
  header.hero{background:linear-gradient(120deg,var(--forest-dark),var(--forest) 55%,var(--forest-light));color:#fff;padding:26px 20px 90px;text-align:center;position:relative;overflow:hidden;}
  header.hero img.school-logo{width:60px;height:60px;border-radius:50%;background:#fff;padding:4px;box-shadow:0 2px 8px rgba(0,0,0,.25);}
  header.hero .school-name{letter-spacing:.12em;font-size:.78rem;font-weight:600;opacity:.9;margin-top:8px;text-transform:uppercase;}
  header.hero h1{margin:8px 0 4px;font-size:2.1rem;font-family:var(--font-display);font-weight:700;text-wrap:balance;}
  header.hero p.sub{margin:2px 0;opacity:.95;}
  header.hero .badges{margin-top:14px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap;}
  header.hero .badge{background:rgba(255,255,255,.2);border:1px solid rgba(255,255,255,.5);padding:6px 14px;border-radius:999px;font-size:.85rem;font-weight:600;}
  nav.tabs{position:sticky;top:0;z-index:50;display:flex;flex-wrap:wrap;justify-content:center;gap:8px;background:#fff;padding:12px 10px;margin:-58px auto 0;border-radius:16px;box-shadow:var(--shadow);max-width:1020px;}
  .nav-btn{border:none;cursor:pointer;padding:10px 16px;border-radius:999px;font-weight:700;font-size:.92rem;background:#EEF1E8;color:var(--ink);transition:all .15s;}
  .nav-btn:hover{transform:translateY(-1px);box-shadow:0 3px 8px rgba(0,0,0,.12);}
  .nav-btn.active{color:#fff;background:linear-gradient(120deg,var(--forest),var(--forest-light));}
  .nav-btn[data-tab="revision"].active{background:linear-gradient(120deg,var(--blue),#7C3AED);}
  .nav-btn[data-tab="unit1"].active{background:linear-gradient(120deg,var(--purple),var(--pink));}
  .nav-btn[data-tab="unit2"].active{background:linear-gradient(120deg,var(--teal),#22D3EE);}
  main{max-width:1020px;margin:26px auto 0;padding:0 16px;}
  .tab-panel{display:none;animation:fadeIn .35s;}
  .tab-panel.active{display:block;}
  @keyframes fadeIn{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:translateY(0);}}
  .unit-banner{border-radius:18px;padding:20px 22px;color:#fff;margin-bottom:18px;box-shadow:var(--shadow);background:linear-gradient(120deg,var(--forest-dark),var(--forest));}
  .unit1 .unit-banner{background:linear-gradient(120deg,var(--purple),var(--pink));}
  .unit2 .unit-banner{background:linear-gradient(120deg,var(--teal-dark),var(--teal),#22D3EE);}
  .unit-banner h2{margin:0 0 6px;font-size:1.5rem;font-family:var(--font-display);font-weight:700;}
  .unit-banner p{margin:0;opacity:.95;}
  .accordion{margin-bottom:14px;border-radius:16px;overflow:hidden;box-shadow:var(--shadow);background:var(--card);}
  .acc-header{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:16px 18px;cursor:pointer;font-weight:700;font-size:1.05rem;color:#fff;font-family:var(--font-display);background:linear-gradient(100deg,var(--forest),var(--forest-light));}
  .unit1 .acc-header{background:linear-gradient(100deg,var(--purple),#9F67FF);}
  .unit2 .acc-header{background:linear-gradient(100deg,var(--teal-dark),#14B8A6);}
  .acc-header .chev{transition:transform .25s;}
  .accordion.open .acc-header .chev{transform:rotate(180deg);}
  .acc-body{max-height:0;overflow:hidden;transition:max-height .3s;}
  .accordion.open .acc-body{max-height:8000px;}
  .acc-content{padding:18px 20px 22px;}
  .objective-tag{display:inline-block;background:#EEF2FF;color:#3730A3;border:1px solid #C7D2FE;border-radius:10px;padding:8px 12px;font-size:.85rem;font-weight:600;margin:0 0 14px;}
  .objective-tag::before{content:"\\1F3AF Objective(s): ";}
  .key-ideas{background:#F5F7F0;border-left:5px solid var(--forest);border-radius:8px;padding:12px 16px;margin-bottom:16px;}
  .key-ideas h4{margin:0 0 8px;font-size:.95rem;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;}
  .key-ideas ul{margin:0;padding-left:20px;}.key-ideas li{margin-bottom:6px;}
  .interactive-block{background:linear-gradient(135deg,#FDF4FF,#F0FDFA);border:2px solid #E9D5FF;border-radius:14px;padding:16px;margin:14px 0;}
  .interactive-block h5{margin:0 0 10px;font-size:1rem;}
  .think-block{background:#FFF7ED;border:2px solid #FDBA74;border-radius:14px;padding:16px;margin:14px 0;}
  .think-block h5{margin:0 0 8px;}.think-block p{margin:6px 0;}
  .quiz-score{font-weight:700;color:var(--forest);margin-bottom:10px;}
  .quiz-q{margin-bottom:14px;}.quiz-question{font-weight:600;margin:0 0 8px;}
  .quiz-opts{display:flex;flex-direction:column;gap:6px;}
  .quiz-opt{text-align:left;padding:9px 12px;border:2px solid var(--line);background:#fff;border-radius:10px;cursor:pointer;font-size:.9rem;font-family:inherit;}
  .quiz-opt:hover:not(:disabled){border-color:var(--forest);}
  .quiz-opt:disabled{cursor:default;opacity:.9;}
  .opt-correct{background:#F0FDF4;border-color:#86EFAC;font-weight:600;}
  .opt-wrong{background:#FEF2F2;border-color:#FCA5A5;}
  .quiz-explain{font-size:.85rem;color:var(--muted);margin:6px 0 0;}
  .flash-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;}
  .flash-hint{font-size:.85rem;color:var(--muted);margin-bottom:10px;}
  .flashcard{perspective:1000px;height:120px;cursor:pointer;}
  .flash-inner{position:relative;width:100%;height:100%;transition:transform .5s;transform-style:preserve-3d;}
  .flashcard.flipped .flash-inner{transform:rotateY(180deg);}
  .flash-front,.flash-back{position:absolute;width:100%;height:100%;backface-visibility:hidden;border-radius:12px;display:flex;align-items:center;justify-content:center;padding:12px;text-align:center;box-shadow:var(--shadow);}
  .flash-front{background:linear-gradient(135deg,var(--forest),var(--forest-light));color:#fff;font-weight:700;}
  .flash-back{background:#fff;border:2px solid var(--forest);transform:rotateY(180deg);font-size:.85rem;}
  .pill{display:inline-block;background:#EEF1E8;border-radius:999px;padding:5px 12px;margin:3px;font-size:.8rem;font-weight:600;color:var(--forest);}
  footer{max-width:1020px;margin:30px auto 0;padding:16px;text-align:center;color:var(--muted);font-size:.85rem;}
</style>
</head>
<body>
<header class="hero">
  <img class="school-logo" src="${CREST}" alt="LOTS crest">
  <div class="school-name">Lusaka Oaktree School</div>
  <h1>${esc(pack.title)}</h1>
  <p class="sub">${esc(meta.yearGroup)} ${esc(meta.subject)} · Weeks ${meta.weekFrom}–${meta.weekTo}</p>
  <div class="badges">${pack.units.map(u => `<span class="badge">${esc(u.unit_label)}</span>`).join('')}</div>
</header>

<nav class="tabs">
  ${unitTabs}
  <button class="nav-btn" data-tab="revision" onclick="showTab('revision')">Revision Zone</button>
</nav>

<main>
  ${unitSections}
  <section id="tab-revision" class="tab-panel">
    <div class="unit-banner" style="background:linear-gradient(120deg,var(--blue),#7C3AED)"><h2>Revision Zone</h2><p>Glossary, a mixed quiz, and the objectives this pack covers.</p></div>
    <div class="accordion open"><div class="acc-header" onclick="toggleAcc(this)"><span>Glossary</span><span class="chev">&#9662;</span></div>
      <div class="acc-body"><div class="acc-content"><div class="flash-hint">Tap a card to flip it.</div><div class="flash-grid" id="flash-glossary"></div></div></div></div>
    ${mixedQuiz.length ? `<div class="accordion"><div class="acc-header" onclick="toggleAcc(this)"><span>Mixed quiz</span><span class="chev">&#9662;</span></div>
      <div class="acc-body"><div class="acc-content"><div id="quiz-mixed"></div></div></div></div>` : ''}
    <div class="accordion"><div class="acc-header" onclick="toggleAcc(this)"><span>Objectives covered</span><span class="chev">&#9662;</span></div>
      <div class="acc-body"><div class="acc-content">${objectivePills || '<p>This span is stated in prose, with no syllabus codes.</p>'}</div></div></div>
  </section>
</main>

<footer>Lusaka Oaktree School · ${esc(meta.subject)} Study Pack · Generated by LOTS AI</footer>

<script>
function toggleAcc(h){h.parentElement.classList.toggle('open');}
function showTab(name){document.querySelectorAll('.tab-panel').forEach(p=>p.classList.remove('active'));document.getElementById('tab-'+name).classList.add('active');document.querySelectorAll('.nav-btn').forEach(b=>b.classList.remove('active'));document.querySelector('.nav-btn[data-tab="'+name+'"]').classList.add('active');window.scrollTo({top:0,behavior:'smooth'});}
function initQuiz(id,questions){var el=document.getElementById(id);if(!el)return;el.innerHTML='<div class="quiz-score">Score: 0 / '+questions.length+'</div>'+questions.map(function(q,qi){return '<div class="quiz-q"><p class="quiz-question">'+(qi+1)+'. '+q.q+'</p><div class="quiz-opts">'+q.options.map(function(o,oi){return '<button class="quiz-opt" data-q="'+qi+'" data-o="'+oi+'">'+o+'</button>';}).join('')+'</div><p class="quiz-explain" data-qi="'+qi+'"></p></div>';}).join('');var score=0,answered=new Array(questions.length).fill(false),scoreEl=el.querySelector('.quiz-score');el.querySelectorAll('.quiz-opt').forEach(function(btn){btn.addEventListener('click',function(){var qi=+btn.dataset.q,oi=+btn.dataset.o;if(answered[qi])return;answered[qi]=true;var q=questions[qi],opts=el.querySelectorAll('.quiz-opt[data-q="'+qi+'"]');opts.forEach(function(o){o.disabled=true;});if(oi===q.correct){btn.classList.add('opt-correct');score++;}else{btn.classList.add('opt-wrong');opts[q.correct].classList.add('opt-correct');}el.querySelector('.quiz-explain[data-qi="'+qi+'"]').textContent='\\uD83D\\uDCA1 '+q.explain;scoreEl.textContent='Score: '+score+' / '+questions.length;});});}
function initFlash(id,cards){var el=document.getElementById(id);if(!el)return;el.innerHTML=cards.map(function(c){return '<div class="flashcard" onclick="this.classList.toggle(\\'flipped\\')"><div class="flash-inner"><div class="flash-front">'+c.front+'</div><div class="flash-back">'+c.back+'</div></div></div>';}).join('');}
document.addEventListener('DOMContentLoaded',function(){
  var quizzes=${json(quizData)};
  Object.keys(quizzes).forEach(function(k){initQuiz(k,quizzes[k]);});
  initFlash('flash-glossary',${json(pack.glossary.map(g => ({ front: g.term, back: g.definition })))});
  var mixed=${json(mixedQuiz)};
  if(mixed.length)initQuiz('quiz-mixed',mixed);
  showTab('${pack.units.length ? 'unit0' : 'revision'}');
});
</script>
</body>
</html>`;
}
