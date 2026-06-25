# Task 1 Report — Tipos compartidos + wrappers de indicadores (SP2)

## Qué se implementó

- `src/lib/scanner/types.ts`: todos los tipos del scanner exactamente como el brief: `Candle`, `CandlesByTimeframe`, `EmaStack`, `MacdCross`, `RsiState`, `MtfAlignment`, `Features`, `DerivativesContext`, `IndicatorSnapshot`, `Signal`, `Timeframes`, `RuleNode`, `TriggerConfig`, `Strategy`.
- `src/lib/scanner/indicators.ts`: wrappers `ema`, `rsiSeries`, `macdSeries`, `adxSeries`, `atrSeries`, `bollingerSeries`, `stochRsiSeries`, `vwapSeries`, `obvSeries`, `mfiSeries` con sus tipos de retorno exportados.
- `src/lib/scanner/indicators.test.ts`: suite del brief (verbatim).
- `package.json` + `package-lock.json`: dependencia `technicalindicators` añadida.

## API real de technicalindicators confirmada contra .d.ts

| Indicador      | Input confirmado                                                                              | Output confirmado              |
|----------------|-----------------------------------------------------------------------------------------------|-------------------------------|
| EMA            | `{ period, values }`                                                                          | `number[]`                    |
| RSI            | `{ period, values }`                                                                          | `number[]`                    |
| MACD           | `{ values, fastPeriod, slowPeriod, signalPeriod, SimpleMAOscillator, SimpleMASignal }`        | `{ MACD?, signal?, histogram? }[]` |
| ADX            | `{ high, low, close, period }`                                                                | `{ adx, pdi, mdi }[]`         |
| ATR            | `{ high, low, close, period }`                                                                | `number[]`                    |
| BollingerBands | `{ period, values, stdDev }`                                                                  | `{ middle, upper, lower, pb }[]` |
| StochasticRSI  | `{ values, rsiPeriod, stochasticPeriod, kPeriod, dPeriod }`                                   | `{ stochRSI, k, d }[]`        |
| VWAP           | `{ high, low, close, volume }`                                                                | `number[]`                    |
| OBV            | `{ close, volume }`                                                                           | `number[]`                    |
| MFI            | `{ high, low, close, volume, period }`                                                        | `number[]`                    |

**Diferencia con el brief**: el campo de MACD se llama `SimpleMASignal` (no `SimpleMASignalValues`).
Se corrigió solo el cuerpo interno de `macdSeries`; la firma pública no cambió.

**Tipos propios**: `technicalindicators` sí incluye sus `.d.ts` — no hizo falta `declare module`.

## Evidencia TDD RED → GREEN

### RED (step 3)
```
npx vitest run src/lib/scanner/indicators.test.ts
FAIL  src/lib/scanner/indicators.test.ts
Error: Cannot find module './indicators.ts'
Test Files  1 failed (1)
```

### GREEN (step 6)
```
npx vitest run src/lib/scanner/indicators.test.ts
Test Files  1 passed (1)
      Tests  3 passed (3)
   Duration  701ms
```

### Typecheck
```
npm run typecheck
(sin salida — cero errores)
```

## Archivos cambiados

- `src/lib/scanner/types.ts` (nuevo)
- `src/lib/scanner/indicators.ts` (nuevo)
- `src/lib/scanner/indicators.test.ts` (nuevo)
- `package.json` (dependencia añadida)
- `package-lock.json` (actualizado)

## Auto-revisión

- Firmas públicas coinciden exactamente con las del brief.
- Sin `any`, sin secretos, sin `console.log`.
- Funciones pequeñas (<50 líneas), archivos <100 líneas.
- Tests pasan y typecheck limpio.

## Concerns

Ninguno.
