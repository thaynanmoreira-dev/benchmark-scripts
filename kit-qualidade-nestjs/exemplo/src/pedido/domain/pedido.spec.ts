import { Pedido } from './pedido';

describe('Pedido', () => {
  const item = { sku: 'a', quantidade: 2, precoUnitarioCentavos: 150 };

  it('soma os itens em centavos', () => {
    expect(new Pedido('p1', [item]).totalCentavos()).toBe(300);
  });

  it('recusa pedido sem item, com a mensagem certa', () => {
    expect(() => new Pedido('p1', [])).toThrow(new RangeError('pedido precisa de ao menos um item'));
  });

  it('aplica desconto', () => {
    expect(new Pedido('p1', [item]).comDesconto(10)).toBe(270);
  });

  it('aceita as fronteiras do intervalo de desconto', () => {
    expect(new Pedido('p1', [item]).comDesconto(0)).toBe(300);
    expect(new Pedido('p1', [item]).comDesconto(100)).toBe(0);
  });

  it('recusa percentual fora do intervalo, com a mensagem certa', () => {
    const pedido = new Pedido('p1', [item]);
    expect(() => pedido.comDesconto(-1)).toThrow(new RangeError('percentual fora do intervalo'));
    expect(() => pedido.comDesconto(101)).toThrow(new RangeError('percentual fora do intervalo'));
  });
});
