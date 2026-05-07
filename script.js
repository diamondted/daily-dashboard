async function load() {
  try {
    const res = await fetch('today.json?t=' + Date.now());
    if (!res.ok) throw new Error('today.json not found');
    const data = await res.json();
    render(data);
  } catch (err) {
    document.getElementById('quote-text').textContent =
      "Today's content hasn't been generated yet. Check back after midnight ET.";
    document.getElementById('eppp-question').textContent = '—';
    document.getElementById('study-title').textContent = '—';
    console.error(err);
  }
}

function render(d) {
  document.getElementById('date').textContent = formatDate(d.date);
  document.getElementById('updated').textContent =
    'Updated ' + formatDate(d.date);

  document.getElementById('quote-text').textContent = '“' + d.quote.text + '”';
  document.getElementById('quote-author').textContent = '— ' + d.quote.author;
  document.getElementById('quote-eli5').textContent = d.quote.eli5;

  document.getElementById('eppp-question').textContent = d.eppp.question;
  const optsEl = document.getElementById('eppp-options');
  optsEl.innerHTML = '';
  const letters = ['A', 'B', 'C', 'D'];
  d.eppp.options.forEach((opt, i) => {
    const div = document.createElement('div');
    div.className = 'option';
    div.dataset.index = i;
    div.innerHTML = `<span class="option-letter">${letters[i]}.</span><span>${opt}</span>`;
    div.addEventListener('click', () => pick(i, d.eppp.correctIndex));
    optsEl.appendChild(div);
  });

  document.getElementById('eppp-correct').textContent =
    letters[d.eppp.correctIndex] + '. ' + d.eppp.options[d.eppp.correctIndex];
  document.getElementById('eppp-eli5').textContent = d.eppp.eli5;
  const whyEl = document.getElementById('eppp-why-wrong');
  whyEl.innerHTML = '';
  d.eppp.whyOthersWrong.forEach((w, i) => {
    if (i === d.eppp.correctIndex) return;
    const li = document.createElement('li');
    li.innerHTML = `<strong>${letters[i]}:</strong> ${w}`;
    whyEl.appendChild(li);
  });

  document.getElementById('eppp-reveal').addEventListener('click', () => {
    showAnswer(d.eppp.correctIndex);
  });

  document.getElementById('study-title').textContent = d.study.title;
  document.getElementById('study-source').textContent = d.study.source;
  const link = document.getElementById('study-link');
  link.href = d.study.url;
  document.getElementById('study-eli5').textContent = d.study.eli5;
}

function pick(chosen, correct) {
  const opts = document.querySelectorAll('.option');
  opts.forEach((el, i) => {
    if (i === correct) el.classList.add('correct');
    else if (i === chosen) el.classList.add('incorrect');
  });
  showAnswer(correct);
}

function showAnswer(correct) {
  document.getElementById('eppp-reveal').classList.add('hidden');
  document.getElementById('eppp-answer').classList.remove('hidden');
  document.querySelectorAll('.option').forEach((el, i) => {
    if (i === correct) el.classList.add('correct');
  });
}

function formatDate(iso) {
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

load();
