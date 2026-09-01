import { Pedido } from '../domain/pedido';
import { PedidoRepositorioMemoria } from './pedido.repositorio.memoria';

describe('PedidoRepositorioMemoria', () => {
  const pedido = new Pedido('p1', [{ sku: 'a', quantidade: 1, precoUnitarioCentavos: 100 }]);

  it('devolve o pedido guardado', async () => {
    const repo = new PedidoRepositorioMemoria();
    repo.guardar(pedido);
    await expect(repo.porId('p1')).resolves.toBe(pedido);
  });

  it('devolve null para id desconhecido', async () => {
    await expect(new PedidoRepositorioMemoria().porId('sumido')).resolves.toBeNull();
  });
});
