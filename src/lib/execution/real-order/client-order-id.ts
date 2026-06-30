// clientOrderId determinista de la entrada (FIX H3 de SP13): = signalId = idempotency_key.
// Permite al reconciler recuperar una entrada incierta vía fetchOrder por origClientOrderId,
// sin emparejamiento difuso. El signalId es un ULID (26 chars Crockford base32), dentro del
// límite de newClientOrderId de Binance (~36) y de su charset permitido.
export function entryClientOrderId(signalId: string): string {
  return signalId;
}
