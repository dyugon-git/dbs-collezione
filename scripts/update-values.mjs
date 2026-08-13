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

// --- 3. Scegli la variante "migliore" (Near Mint / Normal se possibile) ---
function pickVariant(card) {
  const variants = card.variants || [];
  if (!variants.length) return null;
  const nmNormal = variants.find(
    (v) => (v.condition || '').toLowerCase().includes('near mint') &&
           (v.printing || '').toLowerCase() === 'normal'
  );
  if (nmNormal) return nmNormal;
  const nm = variants.find((v) => (v.condition || '').toLowerCase().includes('near mint'));
  if (nm) return nm;
  return variants[0];
}

// --- 4. Cerca una carta per nome + numero su JustTCG ---
async function searchCard(trackaloCard, slug) {
  const number = (trackaloCard.code || '').includes('-')
    ? trackaloCard.code.split('-').slice(1).join('-')
    : '';
  const q = encodeURIComponent(trackaloCard.name || trackaloCard.code || '');
  let url = `${JUSTTCG_BASE}/cards?game=${encodeURIComponent(slug)}&q=${q}&limit=5`;
  if (number) url += `&number=${encodeURIComponent(number)}`;

  const data = await fetchJson(url, { headers: { 'x-api-key': JUSTTCG_API_KEY } });
  const results = data.data || [];
  if (!results.length) return null;

  // Se più risultati, preferiamo quello col numero che combacia esattamente
  if (number) {
    const exact = results.find((r) => String(r.number || '').replace(/^0+/, '') === number.replace(/^0+/, ''));
    if (exact) return exact;
  }
  return results[0];
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
      const best = await searchCard(card, slug);
      requestsUsed++;
      if (best) {
        card.justtcgId = best.id || best.cardId;
        const variant = pickVariant(best);
        if (variant && typeof variant.price === 'number') {
          card.value = round2(variant.price * usdToEur);
          updatedCount++;
        }
        card.justtcgSearchFailedAt = null;
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
      failedSearches.length ? `- Non trovate: ${failedSearches.join(', ')}` : '',
    ].join('\n');
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  }
}

main().catch((err) => {
  console.error('Errore fatale:', err);
  process.exit(1);
});
