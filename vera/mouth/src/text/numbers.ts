// Numbers, times, and money as spoken English.

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
]
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]
const SCALES = ["", "thousand", "million", "billion", "trillion", "quadrillion"]

function underThousand(n: number): string {
  const parts: string[] = []
  const h = Math.floor(n / 100)
  const r = n % 100
  if (h) parts.push(`${ONES[h]} hundred`)
  if (r) {
    if (r < 20) parts.push(ONES[r])
    else parts.push(TENS[Math.floor(r / 10)] + (r % 10 ? `-${ONES[r % 10]}` : ""))
  }
  return parts.join(" ")
}

/** 1234 -> "one thousand two hundred thirty-four". Handles negatives and integers up to quadrillions. */
export function intToWords(n: number | bigint): string {
  let v = BigInt(n)
  if (v === 0n) return "zero"
  if (v < 0n) return `minus ${intToWords(-v)}`
  const groups: string[] = []
  let i = 0
  while (v > 0n) {
    const g = Number(v % 1000n)
    if (g) groups.unshift(underThousand(g) + (SCALES[i] ? ` ${SCALES[i]}` : ""))
    v /= 1000n
    i++
    if (i >= SCALES.length && v > 0n) return digitsToWords(String(n))
  }
  return groups.join(" ")
}

export function digitsToWords(s: string): string {
  return [...s].filter((c) => /\d/.test(c)).map((d) => ONES[Number(d)]).join(" ")
}

/** "3.14" -> "three point one four". */
export function decimalToWords(s: string): string {
  const neg = s.startsWith("-")
  const [int, frac] = s.replace(/^-/, "").split(".")
  const head = intToWords(BigInt(int || "0"))
  const out = frac ? `${head} point ${digitsToWords(frac)}` : head
  return neg ? `minus ${out}` : out
}

/** 1999 -> "nineteen ninety-nine", 2005 -> "two thousand five", 2026 -> "twenty twenty-six". */
export function yearToWords(y: number): string {
  if (y >= 2000 && y < 2010) return intToWords(y)
  if (y % 100 === 0 && y % 1000 !== 0) return `${intToWords(y / 100)} hundred`
  const hi = Math.floor(y / 100)
  const lo = y % 100
  if (lo === 0) return intToWords(y)
  return `${intToWords(hi)} ${lo < 10 ? `oh ${ONES[lo]}` : intToWords(lo)}`
}

const ORDINAL_IRREGULAR: Record<string, string> = {
  one: "first", two: "second", three: "third", five: "fifth", eight: "eighth",
  nine: "ninth", twelve: "twelfth",
}

/** 21 -> "twenty-first". */
export function ordinalToWords(n: number): string {
  const words = intToWords(n)
  const m = /([a-z]+)$/.exec(words)!
  const last = m[1]
  let ord: string
  if (ORDINAL_IRREGULAR[last]) ord = ORDINAL_IRREGULAR[last]
  else if (last.endsWith("y")) ord = last.slice(0, -1) + "ieth"
  else ord = last + "th"
  return words.slice(0, m.index) + ord
}

/** "3:05" -> "three oh five", "10:00" -> "ten o'clock", with an optional am/pm. */
export function timeToWords(h: number, m: number, meridiem?: string): string {
  const mer = meridiem ? ` ${meridiem.replace(/\./g, "").toUpperCase().split("").join(" ")}` : ""
  const hour = intToWords(h === 0 && meridiem ? 12 : h)
  if (m === 0) return meridiem ? `${hour}${mer}` : `${hour} o'clock`
  const min = m < 10 ? `oh ${ONES[m]}` : intToWords(m)
  return `${hour} ${min}${mer}`
}

const CURRENCY: Record<string, [string, string, string, string]> = {
  $: ["dollar", "dollars", "cent", "cents"],
  "€": ["euro", "euros", "cent", "cents"],
  "£": ["pound", "pounds", "penny", "pence"],
}

const MAGNITUDE: Record<string, string> = { k: "thousand", m: "million", b: "billion", bn: "billion", t: "trillion" }

/** "$5.20" -> "five dollars and twenty cents"; "$3.5k" -> "three point five thousand dollars". */
export function moneyToWords(symbol: string, amount: string, magnitude?: string): string {
  const [one, many, subOne, subMany] = CURRENCY[symbol] ?? CURRENCY.$
  const clean = amount.replace(/,/g, "")
  if (magnitude) {
    return `${decimalToWords(clean)} ${MAGNITUDE[magnitude.toLowerCase()]} ${many}`
  }
  const [int, frac] = clean.split(".")
  const whole = BigInt(int || "0")
  const words = `${intToWords(whole)} ${whole === 1n ? one : many}`
  if (!frac || /^0+$/.test(frac)) return words
  const cents = Number(frac.padEnd(2, "0").slice(0, 2))
  if (whole === 0n) return `${intToWords(cents)} ${cents === 1 ? subOne : subMany}`
  return `${words} and ${intToWords(cents)} ${cents === 1 ? subOne : subMany}`
}

/** A bare number as it should be read: years, grouped thousands, decimals, plain integers. */
export function numberToWords(raw: string): string {
  const s = raw.replace(/,/g, "")
  if (s.includes(".")) return decimalToWords(s)
  if (/^-?0\d+$/.test(s)) return digitsToWords(s) // leading zero: read digits ("007")
  if (s.replace("-", "").length > 15) return digitsToWords(s)
  return intToWords(BigInt(s))
}
