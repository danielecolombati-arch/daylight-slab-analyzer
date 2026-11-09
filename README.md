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
vendor/rhino3dm/      rhino3dm.js + wasm (lettura file .3dm)
test/                 test motore, test end-to-end, generatore .3dm di prova
```

## Idee per le prossime versioni

- Cielo sereno e sole diretto per data e ora (illuminamento puntuale, ore di sole)
- Climate-based daylight (sDA, ASE, UDI) da file meteo EPW
- Trasmittanza del vetro dipendente dall'angolo, materiali per singolo oggetto
- Report PDF

## Licenza

MIT
