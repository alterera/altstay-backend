const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const full = fs.readFileSync('prisma/schema.prisma', 'utf8');
const snapshotDir = path.join('prisma', 'schema-snapshots');
fs.mkdirSync(snapshotDir, { recursive: true });

function removeLines(content, lines) {
  let result = content;
  for (const line of lines) {
    result = result.replace(`  ${line}\n`, '');
  }
  return result;
}

const propertyRelationLines = {
  '002': [],
  '003': ['roomTypes    RoomType[]', 'rooms        Room[]', 'amenities    PropertyAmenity[]', 'images       PropertyImage[]'],
  '004': ['policies     PropertyPolicy[]', 'ratePlans    RatePlan[]'],
  '005': ['reservations Reservation[]'],
};

const roomTypeRelationLines = {
  '003': [],
  '004': ['inventory        RoomInventory[]', 'ratePlans        RatePlan[]'],
  '005': ['reservationItems ReservationItem[]', 'inventoryHolds   InventoryHold[]'],
};

const ratePlanRelationLines = {
  '004': [],
  '005': ['reservationItems ReservationItem[]'],
};

function applySnapshotRelations(content, stepId) {
  let result = content;
  const propertyOrder = ['002', '003', '004', '005'];
  for (const id of propertyOrder) {
    if (id > stepId) {
      result = removeLines(result, propertyRelationLines[id]);
    }
  }
  const roomTypeOrder = ['003', '004', '005'];
  for (const id of roomTypeOrder) {
    if (id > stepId) {
      result = removeLines(result, roomTypeRelationLines[id]);
    }
  }
  const ratePlanOrder = ['004', '005'];
  for (const id of ratePlanOrder) {
    if (id > stepId) {
      result = removeLines(result, ratePlanRelationLines[id]);
    }
  }
  if (stepId < '005') {
    result = removeLines(result, ['reservations        Reservation[]']);
  }
  if (stepId < '002') {
    result = removeLines(result, ['organizationMembers OrganizationMember[]']);
  }
  if (stepId < '006') {
    result = removeLines(result, [
      'payments       Payment[]',
      'reviews        Review[]',
    ]);
  }
  if (stepId < '007') {
    result = removeLines(result, ['reviews        Review[]']);
  }
  return result;
}

const authOnly = applySnapshotRelations(
  full.split('// ---------------------------------------------------------------------------\n// Migration 002')[0].trimEnd(),
  '001',
);

const steps = [
  { id: '002', name: 'organizations_properties', end: '// ---------------------------------------------------------------------------\n// Migration 003' },
  { id: '003', name: 'room_catalog', end: '// ---------------------------------------------------------------------------\n// Migration 004' },
  { id: '004', name: 'inventory_rate_plans', end: '// ---------------------------------------------------------------------------\n// Migration 005' },
  { id: '005', name: 'reservations_holds', end: '// ---------------------------------------------------------------------------\n// Migration 006' },
  { id: '006', name: 'payments_webhooks', end: '// ---------------------------------------------------------------------------\n// Later: reviews' },
];

fs.writeFileSync(path.join(snapshotDir, '001.prisma'), authOnly, 'utf8');

let previousPath = path.join(snapshotDir, '001.prisma');
for (const step of steps) {
  const endIdx = full.indexOf(step.end);
  if (endIdx < 0) throw new Error(`Marker not found for ${step.id}`);
  let snapshot = applySnapshotRelations(full.slice(0, endIdx).trimEnd(), step.id);
  const snapshotPath = path.join(snapshotDir, `${step.id}.prisma`);
  fs.writeFileSync(snapshotPath, snapshot, 'utf8');

  const migrationDir = path.join(
    'prisma',
    'migrations',
    `20260810${step.id}000000_${step.id}_${step.name}`,
  );
  fs.mkdirSync(migrationDir, { recursive: true });

  const sql = execSync(
    `npx prisma migrate diff --from-schema-datamodel "${previousPath}" --to-schema-datamodel "${snapshotPath}" --script`,
    { encoding: 'utf8' },
  );
  // Write UTF-8 without BOM (PowerShell Out-File adds BOM and breaks PostgreSQL).
  fs.writeFileSync(
    path.join(migrationDir, 'migration.sql'),
    sql.replace(/^\uFEFF/, ''),
    { encoding: 'utf8' },
  );
  console.log(`Created ${step.id}: ${migrationDir} (${sql.length} bytes)`);
  previousPath = snapshotPath;
}

const reviewsSql = execSync(
  `npx prisma migrate diff --from-schema-datamodel "${previousPath}" --to-schema-datamodel prisma/schema.prisma --script`,
  { encoding: 'utf8' },
);
if (reviewsSql.trim()) {
  const reviewsDir = path.join('prisma', 'migrations', '202608100070000_007_reviews');
  fs.mkdirSync(reviewsDir, { recursive: true });
  fs.writeFileSync(path.join(reviewsDir, 'migration.sql'), reviewsSql.replace(/^\uFEFF/, ''), {
    encoding: 'utf8',
  });
  console.log(`Created 007 reviews (${reviewsSql.length} bytes)`);
}
