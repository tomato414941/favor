/** Information the operator has explicitly chosen to publish. */
export interface PublicProfile {
  businessType: 'individual' | 'company';
  name?: string;
  representative?: string;
  address?: string;
  phone?: string;
  email: string;
  contactHours: string;
  discloseOnRequest: boolean;
}

export function publicProfile(value: unknown): PublicProfile {
  const fail = () => {
    throw new Error(
      'FAVOR_PUBLIC_PROFILE must contain complete public business and contact information.',
    );
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const item = value as Record<string, unknown>;
  const allowed = [
    'businessType',
    'name',
    'representative',
    'address',
    'phone',
    'email',
    'contactHours',
    'discloseOnRequest',
  ];
  if (Object.keys(item).some((key) => !allowed.includes(key))) return fail();
  if (
    !['individual', 'company'].includes(String(item.businessType)) ||
    typeof item.discloseOnRequest !== 'boolean'
  )
    return fail();
  const text = (key: string, required = true) => {
    const field = item[key];
    if (!required && field === undefined) return undefined;
    if (
      typeof field !== 'string' ||
      !field.trim() ||
      field.length > 500 ||
      /[\u0000-\u001f]/.test(field)
    )
      return fail();
    return field.trim();
  };
  const email = text('email')!;
  if (!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email)) return fail();
  const mayOmit = item.businessType === 'individual' && item.discloseOnRequest;
  const name = text('name', !mayOmit);
  const address = text('address', !mayOmit);
  const phone = text('phone', !mayOmit);
  const representative = text('representative', item.businessType === 'company');
  return {
    businessType: item.businessType as PublicProfile['businessType'],
    ...(name ? { name } : {}),
    ...(address ? { address } : {}),
    ...(phone ? { phone } : {}),
    ...(representative ? { representative } : {}),
    email,
    contactHours: text('contactHours')!,
    discloseOnRequest: item.discloseOnRequest,
  };
}
