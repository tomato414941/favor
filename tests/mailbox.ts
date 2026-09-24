import { AuthService } from '../src/server/auth.js';
import { EmailAuth, type EmailDelivery } from '../src/server/email-auth.js';

export class Mailbox {
  readonly messages: { to: string; code: string }[] = [];
  readonly deliver: EmailDelivery = async (message) => {
    this.messages.push(message);
  };
  code(email: string): string {
    const message = this.messages.findLast((item) => item.to === email.trim().toLowerCase());
    if (!message) throw new Error('No verification email was delivered.');
    return message.code;
  }
  async login(auth: AuthService, email: string, previous?: string): Promise<string> {
    const flow = new EmailAuth(auth, this.deliver);
    const challenge = await flow.start(email);
    return flow.verify(challenge, this.code(email), previous);
  }
}
