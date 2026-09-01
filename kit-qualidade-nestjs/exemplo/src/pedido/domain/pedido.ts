export interface ItemPedido {
  readonly sku: string;
  readonly quantidade: number;
  readonly precoUnitarioCentavos: number;
}

/**
 * Entidade de dominio. Nao conhece Nest, banco, HTTP nem fila — e a razao de
 * `domain` nao poder importar nenhuma outra camada.
 */
export class Pedido {
  constructor(
    readonly id: string,
    readonly itens: readonly ItemPedido[],
  ) {
    if (itens.length === 0) {
      throw new RangeError('pedido precisa de ao menos um item');
    }
  }

  totalCentavos(): number {
    return this.itens.reduce((acc, i) => acc + i.quantidade * i.precoUnitarioCentavos, 0);
  }

  /** Desconto em centavos inteiros. A sobra do arredondamento fica com a casa. */
  comDesconto(percentual: number): number {
    if (percentual < 0 || percentual > 100) {
      throw new RangeError('percentual fora do intervalo');
    }
    return Math.round(this.totalCentavos() * (1 - percentual / 100));
  }
}
