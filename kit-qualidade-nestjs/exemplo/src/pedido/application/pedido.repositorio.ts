import type { Pedido } from '../domain/pedido';

/**
 * Porta. A implementacao vive em `infrastructure`, e a inversao acontece aqui:
 * `application` declara o contrato, `infrastructure` obedece.
 * Classe abstrata em vez de interface porque o Nest precisa de um token de DI
 * que sobreviva ao apagamento de tipos.
 */
export abstract class PedidoRepositorio {
  abstract porId(id: string): Promise<Pedido | null>;
}
