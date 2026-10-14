export const phoneCountries = [
  { id: "RU", name: "Россия", code: "7", lengths: [10] },
  { id: "KZ", name: "Казахстан", code: "7", lengths: [10] },
  { id: "BY", name: "Беларусь", code: "375", lengths: [9] },
  { id: "AM", name: "Армения", code: "374", lengths: [8] },
  { id: "KG", name: "Кыргызстан", code: "996", lengths: [9] },
  { id: "UZ", name: "Узбекистан", code: "998", lengths: [9] },
  { id: "TJ", name: "Таджикистан", code: "992", lengths: [9] },
  { id: "AZ", name: "Азербайджан", code: "994", lengths: [9] },
  { id: "GE", name: "Грузия", code: "995", lengths: [9] },
  { id: "TR", name: "Турция", code: "90", lengths: [10] },
  { id: "CN", name: "Китай", code: "86", lengths: [11] },
  { id: "IN", name: "Индия", code: "91", lengths: [10] },
  { id: "US", name: "США / Канада", code: "1", lengths: [10] },
  { id: "DE", name: "Германия", code: "49", lengths: [10, 11] },
  {
    id: "OTHER",
    name: "Другая страна",
    code: "",
    lengths: [8, 9, 10, 11, 12, 13, 14, 15],
  },
];
export function nationalPhone(
  value: string,
  country: (typeof phoneCountries)[number],
) {
  let digits = value.replace(/\D/g, "");
  const max = Math.max(...country.lengths);
  if (
    country.code &&
    (value.trim().startsWith("+") || digits.length > max) &&
    digits.startsWith(country.code)
  )
    digits = digits.slice(country.code.length);
  else if (
    country.code === "7" &&
    digits.length === 11 &&
    digits.startsWith("8")
  )
    digits = digits.slice(1);
  return digits.slice(0, max);
}
export function formatNationalPhone(digits: string, code: string) {
  if (code !== "7" || !digits) return digits;
  return `(${digits.slice(0, 3)}${digits.length >= 3 ? ") " : ""}${digits.slice(3, 6)}${digits.length > 6 ? "-" + digits.slice(6, 8) : ""}${digits.length > 8 ? "-" + digits.slice(8, 10) : ""}`;
}
