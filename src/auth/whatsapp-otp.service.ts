import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { toGatewayPhoneNumber } from './auth.utils';

type WhatsappSendResponse = {
  status?: boolean;
  msg?: string;
  message?: string;
};

@Injectable()
export class WhatsappOtpService {
  private readonly logger = new Logger(WhatsappOtpService.name);

  constructor(private readonly config: ConfigService) {}

  buildOtpMessage(otp: string): string {
    return `${otp} is OTP for mobile number verification to access Alterstay.\n\nDo not share your OTP with anyone.`;
  }

  async sendOtp(e164Phone: string, otp: string): Promise<void> {
    const apiKey = this.config.get<string>('WHATSAPP_OTP_API_KEY');
    const sender = this.config.get<string>('WHATSAPP_OTP_SENDER');
    const baseUrl =
      this.config.get<string>('WHATSAPP_OTP_API_URL') ??
      'https://wa.alterera.net/send-message';

    if (!apiKey || !sender) {
      this.logger.warn(
        `WhatsApp OTP not configured; skipping delivery to ${e164Phone}`,
      );
      return;
    }

    const gatewayNumber = toGatewayPhoneNumber(e164Phone);

    const body = {
      api_key: apiKey,
      sender,
      number: gatewayNumber,
      message: this.buildOtpMessage(otp),
    };

    let response: Response;
    try {
      response = await fetch(baseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      this.logger.error(`WhatsApp OTP request failed: ${String(error)}`);
      throw new InternalServerErrorException(
        'Could not send OTP. Please try again shortly.',
      );
    }

    let payload: WhatsappSendResponse | null = null;
    try {
      payload = (await response.json()) as WhatsappSendResponse;
    } catch {
      payload = null;
    }

    if (!response.ok || payload?.status === false) {
      const detail =
        payload?.msg ?? payload?.message ?? `HTTP ${response.status}`;
      this.logger.error(`WhatsApp OTP rejected for ${e164Phone}: ${detail}`);
      throw new InternalServerErrorException(
        'Could not send OTP. Please try again shortly.',
      );
    }

    this.logger.log(
      `WhatsApp OTP queued for ${e164Phone} (gateway number: ${gatewayNumber})`,
    );
  }
}
