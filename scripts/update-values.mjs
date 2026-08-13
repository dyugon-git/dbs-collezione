// scripts/update-values.mjs
//
// Legge la collezione dal Gist di Trackalo, cerca ogni carta su JustTCG,
// converte il prezzo USD in EUR e scrive il risultato nel campo "value".
//
// Variabili d'ambiente richieste:
//   GIST_TOKEN       token GitHub con permesso "gist" (lo stesso tipo usato dall'app)
//   GIST_ID          id del Gist di Trackalo
//   JUSTTCG_API_KEY  chiave API di justtcg.com (piano free va bene)
//   GAME_FILTER      'all' oppure uno tra 'Dragon Ball' | 'Digimon' | 'Pokémon' | 'One Piece'
//   REMATCH          'true' per ri-cercare anche le carte già matchate
//
// Nota: questo script è stato scritto sulla base della documentazione pubblica
// di JustTCG. Non è mai stato eseguito contro l'API reale (serve una chiave
// che non ho), quindi al primo giro va tenuto d'occhio il log — in particolare
// il punto "adatta qui se necessario" più sotto, dove interpretiamo la
// risposta del batch endpoint.

const GIST_TOKEN = process.env.GIST_TOKEN;
const GIST_ID = process.env.GIST_ID;
const JUSTTCG_API_KEY = process.env.JUSTTCG_API_KEY;
const GAME_FILTER = process.env.GAME_FILTER || 'all';
const REMATCH = process.env.REMATCH === 'true';
const DEBUG = process.env.DEBUG === 'true';
let debugCallsLeft = 3; // stampa la risposta grezza delle prime 3 ricerche, solo se DEBUG=true

const COLLECTION_FILENAME = 'dbsfw_collection.json';
const JUSTTCG_BASE = 'https://api.justtcg.com/v1';

// Quota giornaliera piano free = 100 richieste/giorno.
// Ne teniamo qualcuna di margine per /games e per il cambio valuta.
const DAILY_BUDGET = 90;

// Free plan: 10 richieste al minuto -> aspettiamo un po' più di 6s tra una chiamata e l'altra.
const SLEEP_MS = 6500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args) {
  console.log(new Date().toISOString(), '-', ...args);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Risposta non JSON da ${url}: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} da ${url}: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json;
}

// --- 1. Cambio USD -> EUR (Frankfurter, gratis, senza chiave) ---
async function getUsdToEurRate() {
  const FALLBACK_RATE = 0.92;
  try {
    const data = await fetchJson('https://api.frankfurter.dev/v1/latest?from=USD&to=EUR');
    if (data?.rates?.EUR) {
      log(`Tasso USD->EUR live: ${data.rates.EUR}`);
      return data.rates.EUR;
    }
  } catch (err) {
    log('Impossibile ottenere il tasso di cambio live, uso il fallback:', err.message);
  }
  return FALLBACK_RATE;
}

// --- 2. Mappa gioco Trackalo -> slug gioco JustTCG ---
const GAME_SLUG_OVERRIDES = {
  'dragon ball': 'dragon-ball-super-fusion-world',
};

async function buildGameSlugMap() {
  const data = await fetchJson(`${JUSTTCG_BASE}/games`, {
    headers: { 'x-api-key': JUSTTCG_API_KEY },
  });
  const games = data.data || data.games || data || [];

  function resolve(trackaloGame) {
    const needle = trackaloGame.toLowerCase().replace(/é/g, 'e');
    if (GAME_SLUG_OVERRIDES[needle]) {
      const forced = games.find(
        (g) => (g.id || g.game || '').toLowerCase() === GAME_SLUG_OVERRIDES[needle]
      );
      if (forced) return forced.id || forced.game;
      return GAME_SLUG_OVERRIDES[needle]; // usa comunque lo slug noto anche se non lo troviamo in lista
    }
    const found = games.find((g) => {
      const name = (g.name || g.game || g.id || '').toLowerCase();
      return name.includes(needle) || needle.includes(name);
    });
    return found ? found.id || found.game : null;
  }

  const map = {};
  for (const g of ['Dragon Ball', 'Digimon', 'Pokémon', 'One Piece']) {
    map[g] = resolve(g);
    log(`Gioco "${g}" -> slug JustTCG: ${map[g] || 'NON TROVATO'}`);
  }
  return map;
}

// --- 3. Riconosci se una stringa indica una versione "alt art" / speciale ---
const ALT_ART_KEYWORDS = [
  'alt art', 'alternate art', 'alt-art', 'special art', 'parallel',
  'special illustration', 'full art', 'secret', 'sar', ' ar ', 'gold stamped',
  'holo rare', 'textured',
];
function looksLikeAltArt(str) {
  const s = ` ${(str || '').toLowerCase()} `;
  return ALT_ART_KEYWORDS.some((kw) => s.includes(kw));
}

// --- 4. Scegli la variante "migliore" ---
// Nota: la collezione di questo utente contiene SOLO versioni "alt art" delle
// carte, quindi va sempre preferita — se esplicitamente presente — una
// variante/printing che sembra alt art rispetto a quella "Normal" di base.
function pickVariant(card) {
  const variants = card.variants || [];
  if (!variants.length) return null;

  // 1. Variante alt-art + Near Mint
  const altNm = variants.find(
    (v) => looksLikeAltArt(v.printing) && (v.condition || '').toLowerCase().includes('near mint')
  );
  if (altNm) return altNm;

  // 2. Qualunque variante alt-art
  const alt = variants.find((v) => looksLikeAltArt(v.printing));
  if (alt) return alt;

  // 3. Se il CARD stesso (non solo la variante) sembra alt-art (es. rarity/set nel nome),
  //    va bene anche la variante Normal, perché l'alt-art è già a livello di carta.
  const cardLooksAlt = looksLikeAltArt(card.name) || looksLikeAltArt(card.rarity) || looksLikeAltArt(card.set);
  const nmNormal = variants.find(
    (v) => (v.condition || '').toLowerCase().includes('near mint') && (v.printing || '').toLowerCase() === 'normal'
  );
  if (cardLooksAlt && nmNormal) return nmNormal;

  // 4. Fallback: prima variante Near Mint disponibile, altrimenti la prima in assoluto
  const nm = variants.find((v) => (v.condition || '').toLowerCase().includes('near mint'));
  return nm || variants[0];
}

// --- 5. Cerca una carta per nome (+ codice, confrontato lato client) su JustTCG ---
function baseName(name) {
  // Toglie eventuali sottotitoli dopo i due punti, es. "Son Gohan : Childhood" -> "Son Gohan"
  // (JustTCG potrebbe non usare la stessa sintassi di Trackalo per i sottotitoli)
  return (name || '').split(':')[0].trim();
}

// Normalizza un codice/numero per il confronto: maiuscolo, solo lettere e cifre
// (toglie trattini, spazi, #, zeri iniziali sui soli numeri restano intatti perché
// fanno parte del codice, es. "FB02-130" -> "FB02130").
function normalizeCode(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function searchCard(trackaloCard, slug) {
  const fullCode = trackaloCard.code || ''; // es. "FB02-130" — su JustTCG il campo "number" sembra usare proprio questo formato completo
  const suffix = fullCode.includes('-') ? fullCode.split('-').slice(1).join('-') : ''; // es. "130", fallback nel caso qualche gioco usi solo il numero
  const q = encodeURIComponent(baseName(trackaloCard.name) || fullCode || '');
  const url = `${JUSTTCG_BASE}/cards?game=${encodeURIComponent(slug)}&q=${q}&limit=20`;

  const data = await fetchJson(url, { headers: { 'x-api-key': JUSTTCG_API_KEY } });

  if (DEBUG && debugCallsLeft > 0) {
    debugCallsLeft--;
    log(`[DEBUG] URL: ${url}`);
    log(`[DEBUG] Risposta grezza: ${JSON.stringify(data).slice(0, 2000)}`);
  }

  const results = data.data || [];
  if (!results.length) return { match: null, uncertain: false };

  // 1. Preferiamo un risultato il cui "number" combacia col codice completo (es. "FB02-130"),
  //    con fallback sul solo suffisso numerico se il gioco lo usa diversamente
  let candidates = results;
  const codeMatches = (r) => {
    const rn = normalizeCode(r.number);
    if (!rn) return false;
    if (rn === normalizeCode(fullCode)) return true;
    if (suffix && rn === normalizeCode(suffix)) return true;
    return false;
  };
  const exact = results.filter(codeMatches);
  if (exact.length) candidates = exact;

  // 2. Tra i candidati, se ce n'è uno che sembra chiaramente alt-art, lo preferiamo
  //    (il resto della collezione è tutta alt-art, quindi disambiguare così ha senso)
  const altCandidate = candidates.find(
    (r) => looksLikeAltArt(r.name) || looksLikeAltArt(r.rarity) || (r.variants || []).some((v) => looksLikeAltArt(v.printing))
  );
  if (altCandidate) return { match: altCandidate, uncertain: exact.length === 0 };

  // 3. Altrimenti il primo candidato, segnalato come "incerto" se non avevamo trovato
  //    un match esatto sul codice (quindi meno affidabile)
  return { match: candidates[0], uncertain: exact.length === 0 };
}

// --- 5. Lookup "in batch" per carte già matchate (fino a 20 per richiesta sul piano free) ---
async function batchLookup(cardIds) {
  // ADATTA QUI SE NECESSARIO: la forma esatta della risposta del batch endpoint
  // non è verificabile senza una chiave reale — controllare al primo giro che
  // ogni elemento restituito abbia un campo che permetta di risalire al cardId
  // richiesto (qui assumiamo `id` o `cardId`, con fallback sull'ordine).
  const body = JSON.stringify(cardIds.map((id) => ({ cardId: id })));
  const data = await fetchJson(`${JUSTTCG_BASE}/cards`, {
    method: 'POST',
    headers: {
      'x-api-key': JUSTTCG_API_KEY,
      'Content-Type': 'application/json',
    },
    body,
  });
  return data.data || [];
}

// --- MAIN ---
async function main() {
  if (!GIST_TOKEN || !GIST_ID || !JUSTTCG_API_KEY) {
    throw new Error('Mancano variabili d\'ambiente: GIST_TOKEN, GIST_ID o JUSTTCG_API_KEY');
  }

  log(`Avvio. Filtro gioco: ${GAME_FILTER}. Rematch forzato: ${REMATCH}.`);

  // 1. Leggi il Gist
  const gist = await fetchJson(`https://api.github.com/gists/${GIST_ID}`, {
    headers: { Authorization: `token ${GIST_TOKEN}`, 'User-Agent': 'trackalo-price-updater' },
  });
  const file = gist.files[COLLECTION_FILENAME];
  if (!file) throw new Error(`File ${COLLECTION_FILENAME} non trovato nel Gist`);
  const cards = JSON.parse(file.content);
  log(`Carte totali nel Gist: ${cards.length}`);

  // 2. Setup: cambio valuta + mappa giochi
  const [usdToEur, gameSlugMap] = await Promise.all([getUsdToEurRate(), buildGameSlugMap()]);

  // 3. Seleziona le carte su cui lavorare
  const inScope = cards.filter((c) => GAME_FILTER === 'all' || (c.game || 'Dragon Ball') === GAME_FILTER);

  const matched = inScope.filter((c) => c.justtcgId && !REMATCH);
  const RETRY_AFTER_MS = 7 * 24 * 3600 * 1000; // ricontrolla le carte non trovate dopo 7 giorni
  const unmatched = inScope.filter((c) => {
    if (REMATCH) return true;
    if (c.justtcgId) return false;
    if (c.justtcgSearchFailedAt && Date.now() - c.justtcgSearchFailedAt < RETRY_AFTER_MS) return false;
    return true;
  });
  log(`In ambito: ${inScope.length} (già matchate: ${matched.length}, da cercare: ${unmatched.length})`);

  let requestsUsed = 0;
  let updatedCount = 0;
  const failedSearches = [];
  const uncertainMatches = [];
  const skippedNoSlug = [];

  // 4. Aggiorna le carte già matchate, in batch da 20
  for (const group of chunk(matched, 20)) {
    if (requestsUsed >= DAILY_BUDGET) {
      log('Budget giornaliero esaurito, mi fermo prima di finire i batch.');
      break;
    }
    try {
      const results = await batchLookup(group.map((c) => c.justtcgId));
      requestsUsed++;
      for (const card of group) {
        const match = results.find((r) => r.id === card.justtcgId || r.cardId === card.justtcgId);
        if (!match) continue;
        const variant = pickVariant(match);
        if (!variant || typeof variant.price !== 'number') continue;
        card.value = round2(variant.price * usdToEur);
        updatedCount++;
      }
    } catch (err) {
      log('Errore nel batch lookup:', err.message);
    }
    await sleep(SLEEP_MS);
  }

  // 5. Cerca le carte non ancora matchate, finché c'è budget
  for (const card of unmatched) {
    if (requestsUsed >= DAILY_BUDGET) {
      log('Budget giornaliero esaurito, riprenderà domani con le carte rimanenti.');
      break;
    }
    const slug = gameSlugMap[card.game || 'Dragon Ball'];
    if (!slug) {
      skippedNoSlug.push(card.code);
      continue;
    }
    try {
      const { match: best, uncertain } = await searchCard(card, slug);
      requestsUsed++;
      if (best) {
        card.justtcgId = best.cardId || best.id;
        const variant = pickVariant(best);
        if (variant && typeof variant.price === 'number') {
          card.value = round2(variant.price * usdToEur);
          updatedCount++;
        }
        card.justtcgSearchFailedAt = null;
        if (uncertain) uncertainMatches.push(`${card.code} (${card.name}) -> "${best.name}" #${best.number || '?'}`);
      } else {
        card.justtcgSearchFailedAt = Date.now();
        failedSearches.push(`${card.code} (${card.name})`);
      }
    } catch (err) {
      log(`Errore nella ricerca di ${card.code}:`, err.message);
      failedSearches.push(`${card.code} (${card.name}) - errore: ${err.message}`);
    }
    await sleep(SLEEP_MS);
  }

  // 6. Salva solo il file della collezione sul Gist (non tocca budget/friends/album)
  await fetchJson(`https://api.github.com/gists/${GIST_ID}`, {
    method: 'PATCH',
    headers: {
      Authorization: `token ${GIST_TOKEN}`,
      'User-Agent': 'trackalo-price-updater',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      files: { [COLLECTION_FILENAME]: { content: JSON.stringify(cards, null, 2) } },
    }),
  });

  // 7. Riepilogo
  log(`Fatto. Richieste JustTCG usate: ${requestsUsed}. Carte aggiornate: ${updatedCount}.`);
  if (uncertainMatches.length) {
    log(`Match incerti da verificare a mano (${uncertainMatches.length}):`, uncertainMatches.join(' | '));
  }
  if (failedSearches.length) {
    log(`Carte non trovate (${failedSearches.length}):`, failedSearches.join(', '));
  }
  if (skippedNoSlug.length) {
    log(`Carte saltate per gioco senza slug JustTCG (${skippedNoSlug.length}):`, skippedNoSlug.join(', '));
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const fs = await import('node:fs/promises');
    const summary = [
      '## Aggiornamento valori Trackalo',
      '',
      `- Carte in ambito: ${inScope.length}`,
      `- Richieste JustTCG usate: ${requestsUsed} / ${DAILY_BUDGET}`,
      `- Carte aggiornate: ${updatedCount}`,
      `- Ancora da matchare: ${unmatched.length - (requestsUsed - chunk(matched, 20).length)}`,
      uncertainMatches.length ? `- Match incerti (verifica a mano): ${uncertainMatches.join(' | ')}` : '',
      failedSearches.length ? `- Non trovate: ${failedSearches.join(', ')}` : '',
    ].join('\n');
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  }
}

main().catch((err) => {
  console.error('Errore fatale:', err);
  process.exit(1);
});
