import { UnprocessableEntityException } from '@nestjs/common';

export function invalid(message: string): never {
  throw new UnprocessableEntityException({ code: 'INVALID_AVAILABILITY', message });
}

function fields(body: unknown, allowed: string[], required: string[]) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Expected a JSON object.');
  const values = body as Record<string, unknown>;
  const keys = Object.keys(values);
  if (!keys.length || keys.some(key => !allowed.includes(key)) || required.some(key => !keys.includes(key))) {
    invalid('Invalid scheduling fields.');
  }
  return values;
}

export function weeklyInput(body: unknown, partial = false) {
  const keys = ['weekday', 'startLocal', 'endLocal'];
  const { weekday, startLocal, endLocal } = fields(body, keys, partial ? [] : keys);
  if (weekday !== undefined && (typeof weekday !== 'number' || !Number.isInteger(weekday) || weekday < 1 || weekday > 7)) {
    invalid('weekday must be an ISO weekday from 1 to 7.');
  }
  for (const value of [startLocal, endLocal]) {
    if (value !== undefined && (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value))) {
      invalid('Local times must use HH:mm.');
    }
  }
  return { weekday, startLocal, endLocal };
}

const zonedInstant = /^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,6})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

export function blockoutInput(body: unknown, partial = false) {
  const values = fields(body, ['startsAt', 'endsAt', 'reason'], partial ? [] : ['startsAt', 'endsAt']);
  for (const value of [values.startsAt, values.endsAt]) {
    if (value !== undefined && (typeof value !== 'string' || !zonedInstant.test(value))) {
      invalid('Timestamps require an ISO date, time and explicit UTC offset.');
    }
  }
  if (values.reason !== undefined && values.reason !== null &&
      (typeof values.reason !== 'string' || values.reason.includes('\0'))) invalid('Invalid blockout reason.');
  return values;
}
