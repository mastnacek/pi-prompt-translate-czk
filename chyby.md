# Nalezené nedostatky

Review kódu pluginu `pi-prompt-translate-czk` (verze 0.7.0, HEAD `8769ace`).
Rozsah: `index.ts`, `goal.ts`, `agent-hooks.ts`, `translate*.ts`, `config.ts`,
`state.ts`, `display.ts`, `status*.ts`, `command*.ts`, `balance.ts`, `prompts.ts`.

Stav při review: 38 testů projde, `tsc --noEmit` čistý, `git status` čistý.
Runtime engine: pi 0.99.1.

---

## Stav oprav

Všechny nálezy 1–8 jsou opravené v commitu `1a2412f` (vetev `fix/review-findings`).
Stav: **51 testů prochází, `tsc --noEmit` čistý** (proti engine 0.99.1).
Každý nález má níže řádek **Stav:** s odkazem na konkrétní změnu.

---

## 1. `/goal` se po `/reload` přestane překládat — bez jakékoli hlášky

**Vážnost: major**

**Stav: ✅ opraveno** — `goal.ts`: marker už není early-return brána. Handler se
zapisuje do `PROMPT_INTERCEPTOR_HANDLER` při každém načtení (wrapper na prototypu
čte symbol pokaždé, takže po `/reload` volá aktuální `state`), rozbalování jde
vždy z `PROMPT_INTERCEPTOR_ORIGINAL`, aby nevznikl re-wrap re-wrapu. Nově
`uninstallPromptInterceptor()` vrací `proto.prompt` do původního stavu;
`index.ts` instaluje na `session_start` a odstraňuje v `session_shutdown`.

---

## 1. `/goal` se po `/reload` přestane překládat — bez jakékoli hlášky

**Vážnost: major**

### Kde

`goal.ts:179-206` — patch na `AgentSession.prototype.prompt` je guardovaný
symbolem z globálního registry:

```ts
const PROMPT_INTERCEPTOR_MARKER = Symbol.for("pi-prompt-translate.prompt-interceptor");
// ...
if (proto[PROMPT_INTERCEPTOR_MARKER]) return;   // goal.ts:184
const original = proto.prompt;
// ...
proto[PROMPT_INTERCEPTOR_MARKER] = true;       // goal.ts:205
```

`Symbol.for()` přežije jakékoli načtení modulu i celý proces. Pi při `/reload`
postupuje takto:

- `agent-session.js:2870` — `emitSessionShutdownEvent(oldRunner, { reason: "reload" })`
- hned potom `oldRunner.invalidate()`
- `resource-loader.js:353` — `clearExtensionCache()` (zvyšuje generation, vyprázdní cache)
- nový import extensionu → **čerstvý modulový graf, nový objekt `state`**

`index.ts:173-179` v `session_shutdown` vynuluje `state.sessionCtx` starému běhu.
Nový běh naplní `sessionCtx` jen ve svém vlastním `state` (`index.ts:159`).

### Co se stane

Druhý běh `installPromptInterceptor()` narazí na marker na řádku 184 a skončí
na `return`. Prototyp tedy dál volá **closure z prvního běhu**, která drží
`state` prvního běhu — s vynulovaným `sessionCtx`. `goal.ts:113-114`:

```ts
const ctx = state.sessionCtx;
if (!ctx) return text;      // tichý průchod, překlad se nekoná
```

### Jak se to chová

Překlad promptů funguje dál — ten jde přes `pi.on("input")`, který se
re-registruje normálně. Přestane fungovat jen `/goal`. Zadáš
`/goal oprav ten bug`, agent dostane český text, a ty nevidíš ani warning,
ani hlášku v debugu. Plugin se chová, jako by `/goal` prostě nepodporoval.
Obnoví se to až restartem pi.

### Poznámka k rozsahu

`index.ts:70` (`pi.events.on("at-words:words-updated")`) používá stejný vzor
markeru, ale pi ho přes `runtime.trackEventBusSubscription` (`loader.js:407`)
odregistruje správně. problém je specifický pro přímou interpolaci do
`AgentSession.prototype`, kterou nikdo neřeší.

Navíc to není lifecycle-clean: `extensions.md:60` vyžaduje uvolnění zdrojů
v `session_shutdown` a idempotenci, protože se na ni může sbíhat víc cest
(zrušení, reload, výměna session, exit). Tento patch se neodinstaluje nikdy.

### Návrh fixu

Odstranit patch na prototypu. Pokud `/goal` nelze zachytit přes `input`
event (viz komentář v `goal.ts:3-9` — pi dispatchuje extension commandy před
`input` eventem), pak místo monkey-patchingu raději:

- odposílat překlad přes `pi.sendUserMessage()` z command handleru, nebo
- patchovat přes `Symbol` ale v `session_shutdown` explicitně obnovit
  `proto.prompt = original`, pokud je to nutné.

---

## 2. Karta `quick_win` si při off-by-one markeru prohodí pole

**Vážnost: major**

**Stav: ✅ opraveno** — `parseBlocks` vrací `null`, pokud sada markerů není
přesně `0..count-1`, každý jednou, v pořadí a neprázdný (duplicitní i mimo
pořadí se odmítnou taky). `registerToolUiHooks` na `null` nechá celou kartu
v angličtině a jen zapíše debug, místo aby aplikoval pole, která zrovna sedí.

### Kde

`translate-tool-ui.ts:79-104` (`parseBlocks`) a `107-128` (`applyTranslations`).

Model vrací bloky jako `<<<0>>>` … `<<<N>>>` a parser z toho čte číslo
přímo:

```ts
const match = MARKER_RE.exec(line.trim());
if (match) {
    flush();
    current = Number(match[1]);   // translate-tool-ui.ts:96
    continue;
}
```

`flush()` zapisuje do `parsed[current]`. Žádná kontrola, že číslování začíná
od nuly nebo že je souvislé.

### Jak se to chová

Když model očísluje od 1, `parseBlocks` vrátí pole, kde index 0 chybí a
všecko je o jedno posunuté. `applyTranslations` pak zapíše překlad do
sousedního pole:

```
vstup:  title, impact, steps[0], steps[1], proof, alternative
výstup: title="T", impact="NADPIS", steps=["DOPAD","KROK0"], proof="KROK1", ...
```

Pět polí je obsahově jiné, než mělo být — pod nadpisem je text dopadu —
a šestdé pole zůstane anglické. Karta se vykreslí jako směs.

Řádek 154-160 to zaznamená, ale jen do debugu:

```ts
if (applied < fields.length) {
    debug(ctx, `tool-ui: ${event.toolName} only partially translated ...`);
    return;      // karta už je přepsaná, return nic neopraví
}
```

Karta v tomhle bodě vstupuje do toolu už pozměněná.

### Rozdíl proti zdokumentovanému chování

README (sekce „Tool-UI Text") píše:

> a marker the model drops leaves that field in English rather than
> half-translated

To platí pro *drop* markeru. Pro *posun* číslování neplatí vůbec — a posun je
u drobného modelu pravděpodobnější než úplný drop.

### Návrh fixu

V `parseBlocks` vyhoditit výsledek, pokud jsou indexy nesouvislé nebo
nezačínají od 0:

```ts
const indices = seen.filter((i) => parsed[i] !== undefined);
if (indices.length !== count || indices.some((v, i) => v !== i)) return null;
```

A v `registerToolUiHooks` (`translate-tool-ui.ts:152`) výsledek použít, jen
když je úplný — jinak nechat celou kartu v angličtině, místo aby se aplikovala
část.

---

## 3. Kód v odpovědi jde do překladu nechráněný

**Vážnost: minor (kosmetický, ale viditelný)**

**Stav: ✅ opraveno** — `protectFinalAnswerSegments` dostal pravidla 3 a 5
(promptu): ``` fence(y), inline `` kód a `@file` mentiony. Fence se řeší před
mentiony, aby se placeholdery nevnořovaly. `README.md` to popisuje v sekci
„Code, URL & Integrity Protection".

### Kde

`translate-protect.ts:173-226` (`protectFinalAnswerSegments`).

Prompt varianta (`protectPromptSegments`, `translate-protect.ts:44-171`) má
13 pravidel. Odpověď má jen 4:

| pravidlo | prompt | odpověď |
|---|---|---|
| `[pi-read-all]` hlavičky | 1 | — |
| `<file>`/`<context>`/`<code>` bloky | 2 | tagy s `action` |
| **``` kódové fence** | **3** | **chybí** |
| **inline `` kód** | **3** | **chybí** |
| `@!` triggery | 4 | — |
| **`@` file mentions** | **5** | **chybí** |
| URL | 6 | ano |
| Windows / UNC cesty | 7 | ano |
| Unix / home / relativní cesty | 8 | ano |
| clipboard obrázky | 9 | ano |
| `!term!` markery | 10 | — |
| `?symbol` dotazy | 11 | — |
| at-words (rule 12) | 12 | — |

### Jak se to chová

Když agent odpoví s ```ts ukázkou, kód v odpovědi jde do překladu bez
ochrany. Překladatel ho může přepsat, přeložit identifikátory, nebo rozbít
syntax. Uživatel dostane poškozenou ukázku kódu.

U promptu je to ochrana před tím samým. U odpovědi to chybí — zřejmě
záměr („kód v odpovědi chci číst"), ale pak by to měla být vědomá volba
a ne chybějící pravidlo.

### Návrh fixu

Přidat pravidla 3 a 5 z `protectPromptSegments` do
`protectFinalAnswerSegments`, případně to explicitně zdokumentovat jako
záměr v README.

---

## 4. Opakovaný placeholder se obnoví jen napoprvé

**Vážnost: minor**

**Stav: ✅ opraveno (i vedlejší nález)** — fuzzy větev má `g` flag a nahrazuje
všechy výskyty.Vzor je navíc ukotvený (`(^|[^A-Za-z0-9_])…(?![A-Za-z0-9_])`) a
toleruje jen mezeru/underscore místo `_`: původní `\s` překlenoval i nový řádek,
takže se placeholder "rozlomil" přes dva řádky. Náhrada `$1<value>` zachová
předcházející znak.

### Kde

`translate-protect.ts:228-252` (`restoreProtectedSegments`).

Dvě větve, dvě různé semantiky:

```ts
if (restored.includes(segment.placeholder)) {
    restored = restored.split(segment.placeholder).join(segment.value);  // 235: VŠECHNY
} else {
    const fuzzyRegex = new RegExp(
        segment.placeholder.replace(/_/g, "[_\\s]?"), "i");              // 238-240
    if (fuzzyRegex.test(restored)) {
        restored = restored.replace(fuzzyRegex, segment.value);          // 243: PRVNÍ
    } else {
        restored = `${restored.trimEnd()}\n\n${segment.value}`;          // 247: přilepí
    }
}
```

`String.replace` s regexem bez `g` nahradí jen první výskyt. `split().join()`
nastředu nahrazuje všechny.

### Jak se to chová

Když model placeholder zopakuje (např. odkáže na stejný soubor dvakrát),
přesná větev nahradí oba. Fuzzy větev nahradí jen první a druhý zůstane
v textu doslova:

```
Fix @src/a.ts __PI_PROMPT_TRANSLATE_PROTECTED_0__
```

Agent dostane text s placeholderem uvnitř. Asymetrie mezi větvemi působí jako
nechtěná — když už větev existuje, nahrazuje správně.

### Vedlejší nález ve stejné funkci

Fuzzy fallback s `i` a `[_\\s]?` považuje za legitimní text i
`PI PROMPT TRANSLATE PROTECTED 0` (s mezerami, jiná velikost). Pokud se
takový text objeví v odpovědi agenta, je nahrazen hodnotou cizího segmentu.

### Návrh fixu

Přidat `g` flag:

```ts
restored = restored.replace(fuzzyRegex, segment.value);
```
→
```ts
restored = restored.replace(new RegExp(fuzzyRegex.source, "gi"), segment.value);
```

---

## 5. `<source_text>` není escapovaný

**Vážnost: minor (vědomé rozhodnutí, ne zranitelnost)**

**Stav: ✅ opraveno** — `translate-context.ts`: `createSourceTag()` generuje
tag per request (`source_text_<uuid>`), system prompt jmenovkuje stejný tag
jako payload a `cleanTranslationOutput` ho stripuje. Navíc `escapeForTag()`
escapuje hrubé `</…>` pro všechna naše jména tagů (i ta legacy), takže payload
neobsahuje žádný živý closer. Doporučení „vědomé omezení" už není potřeba —
README popisuje random tag.

### Kde

`translate-context.ts:103-124` (`createTranslationContext`):

```ts
const userContent = conversationContext && conversationContext.trim().length > 0
    ? `<conversation_context>\n${conversationContext.trim()}\n</conversation_context>\n\n<source_text>\n${text}\n</source_text>`
    : `<source_text>\n${text}\n</source_text>`;
```

Text se vloží do tagu bez jakékoli ochrany. System prompt to zakazuje
slovy (`translate.ts:100`: „Do not wrap your output in `<source_text>` tags"),
ale slovo není strukturální záruka.

### Jak se to chová

Prompt obsahující `</source_text>` vymaní payload z kontextu. Zbytek
vstupu se interpretuje jako systémová instrukce. Model může změnit, co
překládá, nebo vyplivnout místo překladu něco jiného.

Proč to není bezpečnostní problém: překládáš vlastní text, takže útočník
by musel být ty. Proč to ale stojí za zmínku: je to přesně ta past, kterou
člověk ztratí z hlavy, protože na ni narazí jednou za dlouho.

### Návrh fixu

Generovat unikátní tag per request a vracet ho v `cleanTranslationOutput`.
Ten už `<source_text>` stripuje (`translate-protect.ts:265-270`), takže
mechanismus existuje — chybí jen parametrizace.

Pokud to zůstane, stojí za to zmínit v README jako vědomé omezení.

---

## 6. `cache hit rate` dělí nesouvisející hodnoty

**Vážnost: minor**

**Stav: ✅ opraveno** — telemetrie má `toolRequests` a `promptAnswerCacheHits`.
Hit rate se počítá z `promptAnswerCacheHits / (promptRequests + answerRequests)`
a `/stats` to píše doslova („N of M prompt+answer requests hit cache");
tool-UI requesty mají vlastní řádek v `Total Requests`.

### Kde

`status-telemetry.ts:124-127`:

```ts
const hitRate =
    tel.totalRequests > 0
        ? ((tel.cacheHitTurns / tel.totalRequests) * 100).toFixed(1)
        : "0.0";
```

`translate.ts:266-273` inkrementuje `totalRequests` pro každý typ requestu
(prompt, answer, tool), ale `promptRequests` a `answerRequests` se plní jen
pro `purpose === "prompt"` a `"answer"`. `cacheHitTurns`
(`translate.ts:277-279`) se inkrementuje při `cacheRead > 0` bez ohledu na typ.

### Jak se to chová

`/prompt-translate stats` zobrazí:

```
• Cache Hit Rate:   X% (Y of Z turns hit cache)
```

Jmenovatel `Z` zahrnuje tool-UI requesty, které do `Y` ani do
`promptRequests`/`answerRequests` nepatří. Po zapnutí
`/prompt-translate ui on` se hit rate systematicky sníží, aniž by se
chovala cache jinak. Není tam nic, co by odhalilo, že jde o jiný
jmenovatel.

### Návrh fixu

Buď počítat hit rate z `cacheHitTurns / (promptRequests + answerRequests)`,
nebo do telemetrie přidat `toolRequests` a jmenovat to v `/stats` upřímně.

---

## 7. Drobnosti

**Stav: ✅ opraveno** — `saveConfig` protahuje `cfg` i v global módu
(`saveGlobalConfig(cfg)` s defaultem), `index.ts` řadí kopii (`[...filteredWords].sort`),
nepoužitá `resetPending()` je smazána. `completions.ts`, `command-toggles.ts`,
`languages.ts`, `status-palette.ts`, `prompts.ts` — beze změny, bez nálezů.

- **`config.ts:151-161`** — `saveConfig(cfg, isGlobal, cwd)` v global módu
  parametr `cfg` úplně ignoruje a píše `state.config`. Jediný dnešní
  volající (`command.ts:25`) předává právě `state.config`, takže je to
  ekvivalentní. Pro dalšího modifikátora je to past.
- **`index.ts:78`** — `filteredWords.sort(...)` mutuje pole, které je
  současně uložené v `state.atWords`. Pole pak zůstane seřazené po délce
  a tato order se propaguje do `setAtWordsRegex` jako pořadí alternativ.
  Funkčně nevadí (JS alternace je řazená, `|ovi|` musí předcházet `|o|`), ale
  není to zamýšlené pořadí.
- **`state.ts:56-58`** — `resetPending()` je exportovaná a nikde nepoužitá.
- **`completions.ts`, `command-toggles.ts`, `languages.ts`,
  `status-palette.ts`, `prompts.ts`** — pročteny, bez nálezů.

---

## 8. Mimo repo: devDeps pinují zastaralý engine

**Vážnost: minor, ale slepá zóna**

**Stav: ✅ opraveno** — devDeps zvednuty na `^0.99.1` (`pi-ai` i
`pi-coding-agent`), `node_modules` má 0.99.1 a `tsc --noEmit` je proti nim
čistý. Přidáno `.github/workflows/check.yml` (`npm ci && npm run check && npm test`).

Tohle je už zaznamenané v `docs/2026-09-29-translation-probe.md`
(sekce „Repo finding: devDeps pin a stale engine"), pořád platí.

`package.json`:

```json
"devDependencies": {
    "@earendil-works/pi-ai": "^0.87.0",
    "@earendil-works/pi-coding-agent": "^0.87.0"
}
```

Ověřeno: `node_modules` má `pi-ai` i `pi-coding-agent` ve verzi **0.87.1**,
běžící engine je **0.99.1**. `^0.87.0` na `0.x` verzi se neplave — je to
strop pod 0.88.

Testy i `tsc --noEmit` tedy typují proti API dvanácti minor verzí staršímu,
než to, co reálně načítá plugin.

Prototyp ověření: při type-checku proti `dist` z 0.99.1 prochází čistě
(tsconfig ukotvený na správné cesty). Není to urgentní — ale je to oblast,
kde se chyba objeví až na breakpointu, ne při psaní kódu.

### Návrh fixu

Zvednout devDeps na `^0.99.0` (nebo `workspace:*`/relativní cestu) a
přidat `pi test` do CI proti aktuální verzi.

---

## Poznámky k testovací sadě

**Stav: ✅ doplněno** — 38 → 51 testů. Chybějící scénáře jsou pokryté:

- **reload test** — nový `goal-interceptor.test.ts` (5 testů: idempotence,
  re-point na state po `/reload`, uninstall, hod od starého handleru)
- **tool-UI index offset** — `translate-tool-ui.test.ts`: numbering od 1,
  vynechaný marker, duplicitní i mimo pořadí, prázdný blok
- **opakovaný placeholder ve fuzzy větvi** — exact i fuzzy větev, dvě
  occurrences; navíc test, že fuzzy nebere přes řádek ani uvnitř slova
- **`protectFinalAnswerSegments` s kódovým blokem** — fence, inline kód,
  `@file`, plus kontrola, že prostý text odpovědi maskovaný není
- **per-request tag** — `</source_text>` v payloadu se escapuje a čistič
  stripuje tag, který dostal

Původní text:
38 testů prochází. Testy jsou celkem kvalitní — `translate-protection.test.ts`
pokrývá i failure módy (drop, duplikát, překlep placeholderu), ne jen happy
path. Chybí ale:

- **reload test** — scénář z Nálezu 1 není pokrytý vůbec
- **tool-UI index offset** — Nález 2 není pokrytý
- **opakovaný placeholder ve fuzzy větvi** — Nález 4 není pokrytý
- **`protectFinalAnswerSegments` s kódovým blokem** — Nález 3 není pokrytý

Všechny čtyři lze testovat čistě na úrovni parserů, bez síťových mocků.
