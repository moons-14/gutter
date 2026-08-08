export const prerender = false;
export function load({ params }: { params: { entity: string; id: string } }) {
  return params;
}
