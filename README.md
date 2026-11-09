# Daylight Slab Analyzer

Web app per calcolare il **Daylight Factor (DF)** e l'illuminamento naturale sulle solette interne di un modello **Rhino (.3dm)**, direttamente nel browser. Non serve installare niente: il file non lascia il tuo computer.

![schema](https://img.shields.io/badge/cielo-CIE%20coperto-e0892b) ![license](https://img.shields.io/badge/license-MIT-lightgrey)

## Come si usa

1. **Carica il modello**: trascina un file `.3dm` (o prova il modello di esempio).
2. **Assegna i layer**: per ogni layer scegli il ruolo:
   - **Solaio**: superfici su cui misurare la luce (la griglia di calcolo viene creata sulle facce orizzontali rivolte verso l'alto);
   - **Opaco**: muri, soffitti, contesto, ostruzioni;
   - **Vetro**: lascia passare la luce con trasmittanza τ (default 0,70);
   - **Ignora**: escluso dal calcolo.

   I ruoli vengono proposti in automatico dal nome del layer (es. `SOLAI`, `VETRI`, `Finestre`, `Glass`…).
   La riflettanza ρ può essere lasciata su *auto*: pavimenti 0,2, pareti 0,5, soffitti 0,7.
3. **Parametri**: passo della griglia, altezza del piano di lavoro (0,75 m), riflettanza del suolo, illuminamento esterno di riferimento (per convertire il DF in lux) e qualità.
4. **Calcola**: il calcolo usa tutti i core del computer.
5. **Risultati**: mappa a colori per livello (vista 3D o pianta), DF medio, minimo, uniformità, percentuale di area sopra la soglia, valori in lux, esportazione CSV e immagine. Passando il mouse sulla mappa leggi il valore puntuale.

### Preparare il file in Rhino

L'app legge le **mesh di rendering** salvate nel file. Se alcune polisuperfici non compaiono:

- salva il file dopo averlo visto in modalità *Shaded* o *Rendered*, e **non** usare *Save Small*;
- oppure converti la geometria in mesh con il comando `_Mesh` prima di salvare.

Le unità del modello (mm, cm, m…) vengono lette dal file; puoi forzarle dal menu *Unità*.

## Località

Il Daylight Factor non dipende dalla località: è un rapporto calcolato con cielo coperto standard. Dalla località dipende invece **quanti lux corrispondono a un dato DF**, attraverso l'illuminamento esterno diffuso mediano nelle ore di luce (*E<sub>v,d,med</sub>*, EN 17037). Per questo la località sposta le soglie e le linee.

Ci sono tre modi per indicarla:

- **File clima `.epw`** di qualsiasi luogo al mondo (gratis su [climate.onebuilding.org](https://climate.onebuilding.org/)). L'app calcola la mediana dell'illuminamento diffuso orizzontale nelle ore con il sole sopra l'orizzonte. Se il file non contiene dati di illuminamento, li stima dalla radiazione diffusa con un'efficacia di 120 lm/W;
- **33 capitali europee** con i valori ufficiali della EN 17037, tab. A.3 (es. Roma 19.200 lx, Londra 14.100 lx, Oslo 12.400 lx);
- **valore manuale**.

## Destinazione d'uso e linee di soglia

Prima del calcolo scegli la destinazione d'uso. Questa imposta l'altezza del piano di lavoro e le **linee di soglia** che vengono disegnate sulla pianta di ogni livello:

| Uso | Linee (lux superati per metà delle ore di luce) | Fonte |
|---|---|---|
| Residenziale | 100 camera · 150 soggiorno · 200 cucina | Annesso nazionale UK alla EN 17037 (BRE 209:2022) |
| Uffici | 300 ufficio · 500 lavoro continuo | EN 17037 livelli minimo e medio |
| Industriale | 300 · 500 · 750 | EN 17037 livelli minimo, medio e alto |

Le soglie sono modificabili e ogni linea si può nascondere. Dentro una linea c'è abbastanza luce per quell'uso. Le zone fuori dalle linee sono adatte a servizi, core, bagni e depositi. Una stanza è conforme se almeno metà della sua superficie è dentro la linea giusta.

Per ogni piano l'app indica i m² e la percentuale di superficie dentro ciascuna linea, il DF medio e mediano, il livello EN 17037 raggiunto dall'intero piano e, per i progetti in Italia, il richiamo al D.M. 5/7/1975 (DF medio ≥ 2% per locale).

Per ridurre il rumore del calcolo Monte Carlo, i valori sono leggermente smussati (media 3×3 sulla griglia).

## Metodo di calcolo

- **Cielo**: cielo coperto standard CIE, con luminanza `L(γ) = Lz·(1 + 2 sin γ)/3`. Il DF non dipende quindi da orientamento, data e ora.
- **Path tracing Monte Carlo** dal punto di calcolo verso l'emisfero, con campionamento coseno stratificato e interriflessioni diffuse (roulette russa con probabilità pari a ρ, senza bias).
- **Suolo**: piano lambertiano con riflettanza ρg illuminato dal cielo.
- **Vetro**: trasmissione speculare con τ costante, senza dipendenza angolare. Questo tende a sovrastimare leggermente la luce che entra con angoli radenti.
- **BVH** scritta da zero (`src/engine.js`), senza dipendenze, utilizzabile anche in Node.
- **Filtri**: i punti senza nulla sopra (terrazzi, coperture) sono esclusi come esterni. I punti dentro muri o solidi sono riconosciuti lanciando raggi nelle 6 direzioni degli assi.

Verifiche (`npm test`): il punto orizzontale non ostruito dà DF = 100%, la superficie verticale non ostruita dà ≈ 49,6% (39,6% dal cielo + 10% dal suolo), e la BVH dà gli stessi risultati della forza bruta.

> ⚠️ I risultati sono indicativi e utili in fase di progetto. Per pratiche ufficiali verifica con software validati (Radiance/Honeybee, DIALux, ecc.).

## Sviluppo

```bash
npm install          # solo per i test (three, rhino3dm, playwright-core)
npm test             # test del motore in Node
npx serve .          # o qualsiasi server statico, poi apri http://localhost:3000
```

Struttura:

```
index.html            interfaccia
src/app.js            viewer three.js, import .3dm, UI, risultati
src/engine.js         motore: BVH, path tracing DF, griglia sensori
src/worker.js         Web Worker per il calcolo parallelo
src/demo.js           modello di esempio procedurale
src/climate.js        località: tabella EN 17037 e lettura file EPW
src/contour.js        linee di soglia (marching squares)
vendor/rhino3dm/      rhino3dm.js + wasm (lettura file .3dm)
test/                 test motore, test end-to-end, generatore .3dm di prova
```

## Idee per le prossime versioni

- Riconoscimento automatico delle stanze e verifica per singolo locale
- Cielo sereno e sole diretto per data e ora (illuminamento puntuale, ore di sole)
- Climate-based daylight (sDA, ASE, UDI) da file meteo EPW
- Trasmittanza del vetro dipendente dall'angolo, materiali per singolo oggetto
- Report PDF

## Licenza

MIT
