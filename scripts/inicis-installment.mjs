// 이니시스 공식 "카드사 무이자 할부 이벤트" 페이지를 읽어 결제 페이지용 JSON을 만든다.
// - 페이지에는 여러 달의 표가 최신순으로 쌓여 있다 → 달별 기간을 모두 담고, 프런트가 오늘(KST)이 속한 기간만 고른다.
// - 결제 정보라 틀리면 안 된다 → 표 구조·카드사·개월 형식이 하나라도 예상과 다르면 파일을 쓰지 않고 실패(exit 1)한다.
//
// 사용: node scripts/inicis-installment.mjs [출력경로] [--html 로컬파일]
import fs from 'node:fs'
import path from 'node:path'

const SOURCE_URL = 'https://www.inicis.com/blog/archives/16302'
const OUT = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'inicis/installment.json'
const htmlArg = process.argv.indexOf('--html')

// 이니시스 표기 → 로고 파일 코드 (card-logos/card_{code}.png). 모르는 카드사가 나오면 실패시킨다.
const CARD_CODES = {
  현대: 'hd', 롯데: 'lt', 국민: 'kb', 신한: 'sh', 삼성: 'ss', 비씨: 'bc', BC: 'bc',
  우리: 'wr', 농협: 'nh', 하나: 'hn', 전북: 'jb', 광주: 'kj',
}

const fail = (msg) => {
  console.error(`✖ ${msg}`)
  process.exit(1)
}

// HTML 조각의 태그를 걷어내고 공백을 정리한 텍스트
const textOf = (html) =>
  html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()

// <table> HTML을 rowspan/colspan을 펼친 2차원 텍스트 배열로 만든다
function tableToGrid(tableHtml) {
  const grid = []
  const rows = [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1])
  rows.forEach((rowHtml, r) => {
    grid[r] ??= []
    let c = 0
    for (const cell of rowHtml.matchAll(/<t([dh])([^>]*)>([\s\S]*?)<\/t\1>/gi)) {
      while (grid[r][c] !== undefined) c++
      const rowspan = Number(/rowspan="?(\d+)/i.exec(cell[2])?.[1] ?? 1)
      const colspan = Number(/colspan="?(\d+)/i.exec(cell[2])?.[1] ?? 1)
      const text = textOf(cell[3])
      for (let dr = 0; dr < rowspan; dr++) {
        grid[r + dr] ??= []
        for (let dc = 0; dc < colspan; dc++) grid[r + dr][c + dc] = text
      }
      c += colspan
    }
  })
  return grid
}

// 표 첫 행을 헤더로 보고, 필요한 열 이름이 모두 있는지 확인한 뒤 행 객체 배열로 바꾼다
function gridToRows(grid, required, label) {
  const [header, ...body] = grid
  const idx = Object.fromEntries(required.map((name) => [name, header.indexOf(name)]))
  const missing = required.filter((name) => idx[name] < 0)
  if (missing.length) fail(`${label}: 헤더에 ${missing.join(', ')} 열이 없음 (실제: ${header.join(' | ')})`)
  return body.map((row) => Object.fromEntries(required.map((name) => [name, row[idx[name]] ?? ''])))
}

// "26.11.01 ~26.11.30" → { start: '2026-11-01', end: '2026-11-30' }
function parsePeriod(text, label) {
  const m = /^(\d{2})\.(\d{2})\.(\d{2})\s*~\s*(\d{2})\.(\d{2})\.(\d{2})$/.exec(text)
  if (!m) fail(`${label}: 기간 형식이 예상과 다름 "${text}"`)
  return { start: `20${m[1]}-${m[2]}-${m[3]}`, end: `20${m[4]}-${m[5]}-${m[6]}` }
}

// "현대카드" → { code: 'hd', name: '현대카드' }
function parseCard(text, label) {
  const key = Object.keys(CARD_CODES).find((k) => text.replace(/^(KB|NH)/, '').startsWith(k))
  if (!key || !/카드$/.test(text)) fail(`${label}: 모르는 카드사 "${text}" — CARD_CODES와 로고를 추가해야 함`)
  return { code: CARD_CODES[key], name: text }
}

// "2~3개월" → [2, 3], "7개월" → [7, 7]
function parseMonths(text, label) {
  const m = /^(\d+)(?:\s*~\s*(\d+))?\s*개월$/.exec(text)
  if (!m) fail(`${label}: 개월 형식이 예상과 다름 "${text}"`)
  const from = Number(m[1])
  const to = Number(m[2] ?? m[1])
  if (from < 2 || to < from || to > 36) fail(`${label}: 개월 범위가 비정상 "${text}"`)
  return [from, to]
}

// "5만원 이상" → 50000
function parseMinAmount(text, label) {
  const m = /^(\d+)\s*만\s*원\s*이상$/.exec(text)
  if (!m) fail(`${label}: 할부적용 금액 형식이 예상과 다름 "${text}"`)
  return Number(m[1]) * 10000
}

// "1~3회차" / "1회차" → 그대로 (표시용), 형식만 검증
function parseBurden(text, label) {
  if (!/^\d+(?:\s*~\s*\d+)?\s*회차$/.test(text)) fail(`${label}: 고객부담 형식이 예상과 다름 "${text}"`)
  return text.replace(/\s+/g, '')
}

// 달 블록 하나(h2 제목 ~ 다음 h2 전)에서 EVENT 01·02 표를 읽는다
function parseMonthBlock(title, blockHtml) {
  const tables = [...blockHtml.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0])
  if (tables.length !== 2) fail(`${title}: 표가 2개가 아님 (${tables.length}개)`)

  const full = gridToRows(tableToGrid(tables[0]), ['기간', '카드사', '할부적용 금액', '할부개월', '비고'], `${title} EVENT 01`)
  const partial = gridToRows(tableToGrid(tables[1]), ['기간', '카드사', '할부개월', '고객부담'], `${title} EVENT 02`)
  if (!full.length) fail(`${title}: EVENT 01 행이 없음`)

  const period = parsePeriod(full[0]['기간'], title)
  const sameperiod = (row, label) => {
    const p = parsePeriod(row['기간'], label)
    if (p.start !== period.start || p.end !== period.end) fail(`${label}: 표 안에 기간이 섞여 있음`)
  }

  const cards = full.map((row) => {
    const label = `${title} EVENT 01 ${row['카드사']}`
    sameperiod(row, label)
    const [from, to] = parseMonths(row['할부개월'], label)
    return { ...parseCard(row['카드사'], label), from, to, minAmount: parseMinAmount(row['할부적용 금액'], label), note: row['비고'] }
  })
  if (new Set(cards.map((c) => c.code)).size !== cards.length) fail(`${title}: EVENT 01에 같은 카드사가 두 번 나옴`)

  const partialByCard = new Map()
  for (const row of partial) {
    const label = `${title} EVENT 02 ${row['카드사']} ${row['할부개월']}`
    sameperiod(row, label)
    const card = parseCard(row['카드사'], label)
    const [from, to] = parseMonths(row['할부개월'], label)
    if (!partialByCard.has(card.code)) partialByCard.set(card.code, { ...card, plans: [] })
    partialByCard.get(card.code).plans.push({ from, to, burden: parseBurden(row['고객부담'], label) })
  }

  return { title, ...period, cards, partial: [...partialByCard.values()] }
}

// 페이지 전체에서 "YYYY년 M월 카드사 무이자 할부 혜택 안내" 제목 단위로 달 블록을 나눈다
function parsePage(html) {
  const heads = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)]
    .map((m) => ({ index: m.index, end: m.index + m[0].length, title: textOf(m[1]) }))
    .filter((h) => /^\d{4}년 \d{1,2}월 카드사 무이자 할부 혜택 안내$/.test(h.title))
  if (!heads.length) fail('달별 제목(h2)을 하나도 찾지 못함 — 페이지 구조가 바뀌었을 수 있음')

  const periods = heads.map((h, i) => {
    const blockEnd = heads[i + 1]?.index ?? html.length
    // 마지막 블록은 유의사항 뒤 푸터까지 이어지므로, 표 두 개까지만 잘라낸다
    const block = html.slice(h.end, blockEnd)
    const tables = [...block.matchAll(/<table[\s\S]*?<\/table>/gi)]
    const trimmed = i === heads.length - 1 && tables.length > 2 ? block.slice(0, tables[1].index + tables[1][0].length) : block
    const period = parseMonthBlock(h.title, trimmed)
    const [, y, mo] = /^(\d{4})년 (\d{1,2})월/.exec(h.title)
    if (period.start.slice(0, 7) !== `${y}-${mo.padStart(2, '0')}`) fail(`${h.title}: 제목 월과 표 기간(${period.start})이 다름`)
    return period
  })

  // 유의사항 — 마지막 표 뒤의 문단들 (결제창과 같은 문구를 보여주기 위해 그대로 보관)
  const lastTableEnd = html.lastIndexOf('</table>')
  const tail = html.slice(lastTableEnd, html.indexOf('</section>', lastTableEnd))
  const notes = [...tail.matchAll(/<(?:p|li)[^>]*>([\s\S]*?)<\/(?:p|li)>/gi)].map((m) => textOf(m[1])).filter(Boolean)

  return { source: SOURCE_URL, periods, notes }
}

const html =
  htmlArg > 0
    ? fs.readFileSync(process.argv[htmlArg + 1], 'utf8')
    : await fetch(SOURCE_URL, { headers: { 'User-Agent': 'Mozilla/5.0 (installment-sync)' } }).then((res) => {
        if (!res.ok) fail(`페이지 요청 실패 HTTP ${res.status}`)
        return res.text()
      })

const data = parsePage(html)
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, `${JSON.stringify(data, null, 2)}\n`)

for (const p of data.periods) {
  console.log(`✔ ${p.start}~${p.end}  무이자 ${p.cards.length}개 카드사 / 부분무이자 ${p.partial.length}개 카드사`)
}

// 오늘(KST)이 들어가는 기간이 없으면 결제 페이지에서 안내가 사라진다 → 파일은 쓰되 실패로 알림
const todayKst = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10)
if (!data.periods.some((p) => p.start <= todayKst && todayKst <= p.end)) fail(`오늘(${todayKst}, KST)에 해당하는 기간이 없음`)
