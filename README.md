# NEKVIT — Showreel 2026 · „FULL STOP."

15sekundový motion-design showreel (1920×1080, 60 fps, se zvukem). Obraz vykresluje vlastní WebGL2 engine a zvuk procedurální syntezátor, obojí přímo z kódu. Projekt nepoužívá žádné video, obrázky, 3D modely ani samply.

![Kontaktní arch](media/contact-sheet.png)

**Video:** [`media/NEKVIT-showreel.mp4`](media/NEKVIT-showreel.mp4)

Vermilionová tečka se narodí na první dobu a putuje písmeny jména N-E-K-V-I-T. Každé písmeno je jedna „stanice“ řemesla:

| Písmeno | Záběr | Co ukazuje |
|---|---|---|
| N | `line` | tisk, rastr, rytina |
| E | `plane` | kompozice render passů, masky |
| K | `lens` | skleněná čočka, kinetická typografie |
| V | `volume` | raymarchované sklo, kaustiky, dolly zoom, DOF |
| I | `flow` | fluidní simulace (Navier–Stokes) |
| T | `field` | ~197 000 částic, kamera za kometou |

Na konci tečka přeskáče po písmenech a dopadne jako tečka za jménem.

---

## Jak dát showreel na web

### Varianta A: video (nejjednodušší, doporučeno)

1. Zkopíruj `media/NEKVIT-showreel.mp4` (a volitelně `media/poster.png`) na svůj web.
2. Vlož do HTML:

```html
<video
  src="NEKVIT-showreel.mp4"
  poster="poster.png"
  controls
  playsinline
  preload="metadata"
  style="width:100%; max-width:1280px; aspect-ratio:16/9; background:#0E0E12;">
</video>
```

Automatické přehrávání ve smyčce (třeba jako pozadí hero sekce) prohlížeče povolí jen bez zvuku:

```html
<video src="NEKVIT-showreel.mp4" autoplay muted loop playsinline
       style="width:100%; aspect-ratio:16/9; object-fit:cover;"></video>
```

Tip: YouTube nebo Vimeo ušetří datový přenos a video tam přizpůsobí kvalitu podle připojení. Na web ho pak vložíš jejich `<iframe>` kódem.

### Varianta B: živý WebGL render v prohlížeči

Reel se vykresluje v reálném čase přímo na grafice návštěvníka. Hodí se jako „wow“ ukázka, ale potřebuje prohlížeč s WebGL2 a slušnou grafickou kartu.

1. Nahraj na hosting celou složku projektu: `index.html`, `src/`, `fonts/`, `audio/`. Složky `tools/` a `media/` nejsou potřeba.
2. Otevři `https://tvuj-web.cz/cesta/index.html`.
3. Chceš ho vložit do jiné stránky? Použij iframe:

```html
<iframe src="/showreel/index.html"
        style="width:100%; max-width:1280px; aspect-ratio:16/9; border:0;"
        allow="autoplay; fullscreen"></iframe>
```

Stránku je nutné servírovat přes HTTP(S) (hosting, GitHub Pages, Netlify…). Po otevření `index.html` dvojklikem z disku nefunguje, protože ES moduly a fonty se načítají přes `fetch`.

Lokálně si ji pustíš takhle:

```bash
npx http-server -c-1 .
# pak otevři http://localhost:8080
```

Ovládání: klik = přehrát se zvukem, mezerník = pauza, ←/→ = po snímku, Shift+←/→ = po 10 snímcích, F = celá obrazovka.

**GitHub Pages:** v nastavení repa zvol *Settings → Pages → Deploy from branch → `main` / root*. Reel pak poběží na `https://nekvit.github.io/motion-showreel/`. U soukromého repa to vyžaduje placený účet.

---

## Úpravy

- **Jméno, role, rok:** `src/config.js` (`name`, `role`, `year`). Layout se přepočítá sám pro 2–11 písmen.
- **Zvuk po změně jména:** `node tools/soundtrack.mjs` (vytvoří `audio/soundtrack.wav`).
- **Vyrenderování videa:** `node tools/render.mjs --all --video out/showreel.mp4 --workers 2`. Potřebuje Node 22, Playwright s Chromiem a ffmpeg (nebo `pip install imageio-ffmpeg`).
- **Náhled jednoho záběru:** `node tools/render.mjs --shot volume --step 6 --scale 0.5 --sheet`

## Dokumentace

- [`DIRECTION.md`](DIRECTION.md): umělecké a technické zadání (paleta, typografie, časování na snímek, cue list zvuku)
- [`ENGINE.md`](ENGINE.md): API enginu pro psaní záběrů
- [`SYS.md`](SYS.md): sdílená knihovna layoutu a glyfů

Fonty (Archivo, Instrument Serif, JetBrains Mono, Unbounded) jsou pod licencí SIL OFL, viz `fonts/`.
