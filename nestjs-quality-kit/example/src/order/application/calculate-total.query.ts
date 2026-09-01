export class CalculateTotalQuery {
  constructor(
    readonly orderId: string,
    readonly discountPercent: number,
  ) {}
}
