import { Body, Controller, Get, HttpCode, Post, Req } from '@nestjs/common';
import {
  bootstrapOwnerRequestSchema,
  changePasswordRequestSchema,
  loginRequestSchema,
  refreshRequestSchema,
  type CurrentUser,
  type TokenPair,
} from '@gridflex/contracts';
import type { FastifyRequest } from 'fastify';
import { CurrentUserId, Public } from '../../common/auth/auth.guard.js';
import { zodBody } from '../../common/pipes/zod-validation.pipe.js';
import { AuthService, type RequestContext } from './auth.service.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Lets the sign-in page decide whether to offer first-run setup. */
  @Public()
  @Get('bootstrap-status')
  async bootstrapStatus(): Promise<{ bootstrap_available: boolean }> {
    return { bootstrap_available: await this.auth.isBootstrapAvailable() };
  }

  @Public()
  @Post('bootstrap-owner')
  @HttpCode(201)
  async bootstrapOwner(
    @Body(zodBody(bootstrapOwnerRequestSchema))
    body: {
      email: string;
      display_name: string;
      password: string;
      organization_name: string;
      organization_slug: string;
    },
  ): Promise<{ user_id: string; organization_id: string }> {
    const result = await this.auth.bootstrapOwner({
      email: body.email,
      displayName: body.display_name,
      password: body.password,
      organizationName: body.organization_name,
      organizationSlug: body.organization_slug,
    });
    return { user_id: result.userId, organization_id: result.organizationId };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(zodBody(loginRequestSchema)) body: { email: string; password: string },
    @Req() request: FastifyRequest,
  ): Promise<TokenPair> {
    return this.auth.login(body.email, body.password, contextOf(request));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(
    @Body(zodBody(refreshRequestSchema)) body: { refresh_token: string },
    @Req() request: FastifyRequest,
  ): Promise<TokenPair> {
    return this.auth.refresh(body.refresh_token, contextOf(request));
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentUserId() userId: string): Promise<void> {
    await this.auth.logout(userId);
  }

  @Get('me')
  async me(@CurrentUserId() userId: string): Promise<CurrentUser> {
    return this.auth.currentUser(userId);
  }

  @Post('change-password')
  @HttpCode(204)
  async changePassword(
    @CurrentUserId() userId: string,
    @Body(zodBody(changePasswordRequestSchema))
    body: { current_password: string; new_password: string },
  ): Promise<void> {
    await this.auth.changePassword(userId, body.current_password, body.new_password);
  }
}

function contextOf(request: FastifyRequest): RequestContext {
  const userAgent = request.headers['user-agent'];
  return {
    ...(request.ip ? { ip: request.ip } : {}),
    ...(userAgent ? { userAgent } : {}),
  };
}
