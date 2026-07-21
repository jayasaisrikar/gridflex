import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { DomainError } from '@gridflex/contracts';
import type { FastifyRequest } from 'fastify';
import { TokenService } from '../../modules/auth/token.service.js';

export const IS_PUBLIC = 'gridflex:isPublic';

/** Marks a route as reachable without authentication. */
export const Public = (): MethodDecorator => SetMetadata(IS_PUBLIC, true);

export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
}

/** Injects the authenticated user into a handler parameter. */
export const CurrentUserId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string => {
    const request = context.switchToHttp().getRequest<
      FastifyRequest & { gridflexUser?: AuthenticatedUser }
    >();
    const user = request.gridflexUser;
    if (!user) {
      throw new DomainError('UNAUTHENTICATED', 'Authentication required.', undefined, 401);
    }
    return user.id;
  },
);

/**
 * Bearer-token authentication.
 *
 * Applied globally so a new route is protected by DEFAULT and must opt out with
 * @Public() — the safer direction, since forgetting to add a guard is a far more
 * likely mistake than forgetting to remove one.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<
      FastifyRequest & { gridflexUser?: AuthenticatedUser }
    >();

    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new DomainError('UNAUTHENTICATED', 'Authentication required.', undefined, 401);
    }

    const claims = await this.tokens.verifyAccessToken(header.slice('Bearer '.length).trim());
    request.gridflexUser = { id: claims.sub, email: claims.email };
    return true;
  }
}
