---
name: risk-policy
description: Doctrina cualitativa de cautela y sizing para el decision-maker de Kairos. Cómo traducir la evidencia (reads técnico/fundamental) en sizingFactor y confianza prudentes. Los límites duros viven en el risk gate determinista, no aquí.
---

# Política de riesgo (Kairos)

Doctrina **cualitativa** para fijar `sizingFactor` y `confianza` al emitir el veredicto. **No** define
límites numéricos duros: esos los aplica `check_risk` (determinista, §5/§19) y son el techo no
negociable. Esta doctrina es *advisory* — te ayuda a no sobre-dimensionar.

## Reduce el sizing (y/o baja la confianza) ante

- **Divergencia** precio/momentum (el `technical_read.divergence` no es `none`).
- **MTF no alineado**: `mtfNote` que describe `counter`/`mixed` — el gatillo contra el sesgo HTF pide cautela.
- **Posicionamiento hacinado**: `fundamental_read.positioning: crowded_long` → riesgo de squeeze en una entrada larga.
- **Baja confluencia** (`technical_read.confluence: weak`) o **régimen de rango** (`regime: ranging`) en una ruptura.
- **Catalizador fundamental adverso** o reads **contradictorios** (técnico y fundamental con sesgo opuesto).
- **Confianza propia baja**: si no estás convencido, el `sizingFactor` debe reflejarlo.

## Principios

- **Nunca** subas el `sizingFactor` por encima de tu convicción real. No "apuestas" para recuperar.
- En **ausencia de fundamental** (ventana tranquila), apóyate en la técnica + esta doctrina.
- El `sizingFactor` ∈ [0,1] es un **factor de convicción**, no el tamaño final: el risk gate lo capará
  contra los límites de la estrategia (notional, exposición, drawdown). Aun así, sé honesto: un gate
  que capa un factor inflado no te exime de calibrarlo bien.
- Confluencia fuerte + MTF alineado + sin catalizador adverso + posicionamiento sano → `confianza` alta
  y `sizingFactor` acorde. La cautela no es timidez: es proporcionalidad a la evidencia.
