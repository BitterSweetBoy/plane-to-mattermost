import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { SessionService } from './session.service';
import { User } from '@prisma/client';
import { PrismaClientKnownRequestError } from '@prisma/client/runtime/library';
import { RegisterDto } from './dtos/register.dto';
import { LoginAttemptService } from './login-attempt.service';
import { MAX_ATTEMPTS, TIME_WINDOW_MS } from './constants';


@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private sessions: SessionService,
    private loginAttempts: LoginAttemptService,
  ) {}

  async register( dto: RegisterDto,): Promise<{ id: string; name: string | null; email: string | null }> {
    const { name, email, password } = dto;
    const hash = await bcrypt.hash(password, 12);

    try {
      return await this.prisma.user.create({
        data: { name, email, password: hash },
        select: { id: true, name: true, email: true },
      });
    } catch (err) {
      if (
        err instanceof PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const targets = Array.isArray(err.meta?.target)
          ? (err.meta.target as string[])
          : [];

        if (targets.includes('email')) {
          throw new ConflictException('El email ya está en uso');
        }
      }
      throw err;
    }
  }

  async validateUser(email: string, password: string): Promise<User> {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new UnauthorizedException('Credenciales inválidas');
    const valid = await bcrypt.compare(password, user.password!);
    if (!valid) throw new UnauthorizedException('Credenciales inválidas');
    return user;
  }

  async login(email: string, password: string, userAgent: string, ipAddress: string) {
    const attempts = await this.loginAttempts.getRecentFailedAttempts(email, TIME_WINDOW_MS);
    if (attempts >= MAX_ATTEMPTS) {
      throw new Error ('Demasiados intentos fallidos. Intenta más tarde.');
    }

    try {
      const user = await this.validateUser(email, password);
      await this.loginAttempts.logAttempt(email, ipAddress, userAgent, true);
      const session = await this.sessions.createSession(user.id, userAgent, ipAddress);
      return { user, sessionKey: session.sessionKey };
    } catch (err) {
      await this.loginAttempts.logAttempt(email, ipAddress, userAgent, false);
      throw err;
    }
  }

  async logout(sessionKey: string) {
    await this.sessions.expireSession(sessionKey);
  }
}
