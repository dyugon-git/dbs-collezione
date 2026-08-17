// scripts/update-values.mjs
//
// Aggiorna il campo "value" (valore di mercato in EUR) SOLO per le carte che
// hanno già un campo "justtcgId" impostato a mano sul Gist. Nessuna ricerca
// automatica per nome: l'id va trovato e incollato a mano sulla pagina della
// carta su justtcg.com (campo "slug (v1 id)"), così non c'è rischio di
// prendere la versione sbagliata (es. alt art vs normale).
//
// Variabili d'ambiente richieste:
//   GIST_TOKEN       token GitHub con permesso "gist" (lo stesso tipo usato dall'app)
//   GIST_ID          id del Gist di Trackalo
//   JUSTTCG_API_KEY  chiave API di justtcg.com (piano free va bene)
//   GAME_FILTER      'all' oppure uno tra 'Dragon Ball' | 'Digimon' | 'Pokémon' | 'One Piece'
//   DEBUG            'true' per stampare nei log la risposta grezza del primo batch

const GIST_TOKEN = process.env.GIST_TOKEN;
const GIST_ID = process.env.GIST_ID;
const JUSTTCG_API_KEY = process.env.JUSTTCG_API_KEY;
const GAME_FILTER = process.env.GAME_FILTER || 'all';
const DEBUG = process.env.DEBUG === 'true';

const COLLECTION_FILENAME = 'dbsfw_collection.json';
const JUSTTCG_BASE = 'https://api.justtcg.com/v1';

// Free plan: 10 richieste al minuto -> aspettiamo un po' più di 6s tra un batch e l'altro.
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

// --- Cambio USD -> EUR (Frankfurter, gratis, senza chiave) ---
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

// --- Scegli la variante "migliore" tra quelle della carta trovata ---
// (di solito una sola, ma alcune carte hanno più condizioni: Near Mint, Lightly Played, ecc.)
const ALT_ART_KEYWORDS = [
  'alt art', 'alternate art', 'alt-art', 'special art', 'parallel',
  'special illustration', 'full art', 'secret', 'sar', ' ar ', 'gold stamped',
  'holo rare', 'textured',
];
function looksLikeAltArt(str) {
  const s = ` ${(str || '').toLowerCase()} `;
  return ALT_ART_KEYWORDS.some((kw) => s.includes(kw));
}
function pickVariant(card) {
  const variants = card.variants || [];
  if (!variants.length) return null;
  const altNm = variants.find(
    (v) => looksLikeAltArt(v.printing) && (v.condition || '').toLowerCase().includes('near mint')
  );
  if (altNm) return altNm;
  const alt = variants.find((v) => looksLikeAltArt(v.printing));
  if (alt) return alt;
  const nm = variants.find((v) => (v.condition || '').toLowerCase().includes('near mint'));
  return nm || variants[0];
}

// --- Lookup "in batch" per id (fino a 20 per richiesta sul piano free) ---
async function batchLookup(cardIds) {
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

  log(`Avvio. Filtro gioco: ${GAME_FILTER}.`);

  // 1. Leggi il Gist
  const gist = await fetchJson(`https://api.github.com/gists/${GIST_ID}`, {
    headers: { Authorization: `token ${GIST_TOKEN}`, 'User-Agent': 'trackalo-price-updater' },
  });
  const file = gist.files[COLLECTION_FILENAME];
  if (!file) throw new Error(`File ${COLLECTION_FILENAME} non trovato nel Gist`);
  const cards = JSON.parse(file.content);
  log(`Carte totali nel Gist: ${cards.length}`);

  // 2. Cambio valuta
  const usdToEur = await getUsdToEurRate();

  // 3. Seleziona le carte da aggiornare: solo quelle con justtcgId impostato
  const inScope = cards.filter((c) => GAME_FILTER === 'all' || (c.game || 'Dragon Ball') === GAME_FILTER);
  const withId = inScope.filter((c) => c.justtcgId);
  const withoutId = inScope.length - withId.length;
  log(`In ambito: ${inScope.length} (con ID: ${withId.length}, senza ID - ignorate: ${withoutId})`);

  let requestsUsed = 0;
  let updatedCount = 0;
  const notFound = [];
  let debugPrinted = false;

  for (const group of chunk(withId, 20)) {
    try {
      const results = await batchLookup(group.map((c) => c.justtcgId));
      requestsUsed++;

      if (DEBUG && !debugPrinted) {
        debugPrinted = true;
        log(`[DEBUG] Risposta grezza batch: ${JSON.stringify(results).slice(0, 2000)}`);
      }

      for (const card of group) {
        const match = results.find((r) => r.id === card.justtcgId);
        if (!match) {
          notFound.push(`${card.code} (${card.name}) - id: ${card.justtcgId}`);
          continue;
        }
        const variant = pickVariant(match);
        if (!variant || typeof variant.price !== 'number') {
          notFound.push(`${card.code} (${card.name}) - nessun prezzo nella variante`);
          continue;
        }
        card.value = round2(variant.price * usdToEur);
        updatedCount++;
      }
    } catch (err) {
      log('Errore nel batch lookup:', err.message);
      group.forEach((card) => notFound.push(`${card.code} (${card.name}) - errore: ${err.message}`));
    }
    await sleep(SLEEP_MS);
  }

  // 4. Salva solo il file della collezione sul Gist (non tocca budget/friends/album)
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

  // 5. Riepilogo
  log(`Fatto. Richieste JustTCG usate: ${requestsUsed}. Carte aggiornate: ${updatedCount}.`);
  if (notFound.length) {
    log(`Problemi (${notFound.length}):`, notFound.join(' | '));
  }
  if (withoutId > 0) {
    log(`${withoutId} carte ignorate perché senza justtcgId impostato.`);
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const fs = await import('node:fs/promises');
    const summary = [
      '## Aggiornamento valori Trackalo',
      '',
      `- Carte con ID (aggiornate): ${withId.length}`,
      `- Carte aggiornate con successo: ${updatedCount}`,
      `- Carte senza ID (ignorate): ${withoutId}`,
      `- Richieste JustTCG usate: ${requestsUsed}`,
      notFound.length ? `- Problemi: ${notFound.join(' | ')}` : '',
    ].join('\n');
    await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  }
}

main().catch((err) => {
  console.error('Errore fatale:', err);
  process.exit(1);
});
