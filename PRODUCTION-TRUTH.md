# Production behavior and external network requirements

This is the existing SubhArambh Business App project. The application owns the business workflow: member data, status detection, scripts, campaigns, scheduling, permissions, history, and results.

A normal web server cannot itself terminate calls onto India's PSTN/mobile network or inject messages into WhatsApp users without the corresponding carrier/official WhatsApp network interface. Therefore the project uses provider adapters only at the delivery boundary; it never fakes delivery.

Required for real outbound AI phone calls: a configured telephony/voice provider (Vapi, SIP/telephony carrier, or equivalent) and its credentials.
Required for official WhatsApp business messages: Meta WhatsApp Cloud API or an authorized WhatsApp provider and its credentials/templates.
Required for durable production storage: PostgreSQL via DATABASE_URL.

Without those external network credentials, the Admin UI reports NOT CONNECTED / blocked instead of claiming a call or WhatsApp message was sent.
