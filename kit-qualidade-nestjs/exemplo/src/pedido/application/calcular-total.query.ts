export class CalcularTotalQuery {
  constructor(
    readonly pedidoId: string,
    readonly descontoPercentual: number,
  ) {}
}
