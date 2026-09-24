import { AuthService } from '../src/server/auth.js';
import type { EmailDelivery, EmailMessage } from '../src/server/email-delivery.js';

/** Collects outgoing mail and signs test people in by address. */
export class Mailbox {
  readonly messages: EmailMessage[] = [];
  readonly deliver: EmailDelivery = async (message) => {
    this.messages.push(message);
  };
  async login(auth: AuthService, email: string, name?: string): Promise<string> {
    return auth.demoLoginEmail(email, name);
  }
}
