import 'dotenv/config';
import { PrismaClient, UserStatus } from '../src/generated/prisma/client';
import { createPrismaPgAdapter } from '../src/prisma/pg-adapter';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient({
  adapter: createPrismaPgAdapter(process.env.DATABASE_URL!),
});

const PLATFORM_ROLES = [
  { name: 'CUSTOMER', description: 'Default role for app registrations' },
  { name: 'SUPER_ADMIN', description: 'Full platform administration' },
  { name: 'SUPPORT', description: 'Customer support operations' },
  { name: 'FINANCE', description: 'Refunds and financial reconciliation' },
] as const;

const PROPERTY_TYPES = [
  { code: 'HOTEL', name: 'Hotel', description: 'Standard hotel property' },
  { code: 'RESORT', name: 'Resort', description: 'Resort property' },
  { code: 'VILLA', name: 'Villa', description: 'Villa property' },
  { code: 'HOMESTAY', name: 'Homestay', description: 'Homestay property' },
  { code: 'APARTMENT', name: 'Apartment', description: 'Apartment property' },
  { code: 'HOSTEL', name: 'Hostel', description: 'Hostel property' },
] as const;

const AMENITIES = [
  { name: 'Free WiFi', category: 'CONNECTIVITY' },
  { name: 'Swimming Pool', category: 'WELLNESS' },
  { name: 'Parking', category: 'FACILITIES' },
  { name: 'Restaurant', category: 'DINING' },
  { name: 'Gym', category: 'WELLNESS' },
  { name: 'Air Conditioning', category: 'ROOM' },
  { name: 'Room Service', category: 'DINING' },
  { name: '24/7 Front Desk', category: 'SERVICES' },
] as const;

const MEAL_PLANS = [
  { code: 'ROOM_ONLY', name: 'Room Only' },
  { code: 'BREAKFAST', name: 'Breakfast Included' },
  { code: 'HALF_BOARD', name: 'Breakfast + Dinner' },
  { code: 'FULL_BOARD', name: 'All Meals Included' },
] as const;

const PROPERTY_TAGS = [
  { code: 'COUPLE_FRIENDLY', name: 'Couple Friendly' },
  { code: 'ACCEPTS_LOCAL_ID', name: 'Accepts Local ID' },
  { code: 'PAY_AT_HOTEL', name: 'Pay At Hotel' },
] as const;

const CITIES_WITH_AREAS = [
  {
    name: 'Guwahati',
    slug: 'guwahati',
    state: 'Assam',
    areas: ['Dispur', 'Paltan Bazaar', 'Ulubari', 'Beltola', 'Six Mile', 'Pan Bazaar'],
  },
  {
    name: 'Delhi',
    slug: 'delhi',
    state: 'Delhi',
    areas: [
      'Connaught Place',
      'Dwarka',
      'Chhatarpur',
      'Karol Bagh',
      'Aerocity',
      'Paharganj',
      'Nehru Place',
    ],
  },
  {
    name: 'Mumbai',
    slug: 'mumbai',
    state: 'Maharashtra',
    areas: ['Andheri', 'Bandra', 'Colaba', 'Powai', 'Juhu', 'Lower Parel'],
  },
] as const;

const MEMBERSHIP_PLANS = [
  {
    code: 'INDIVIDUAL',
    name: 'Premium',
    price: 1,
    durationDays: 365,
    discountPercent: 5,
    benefitsDescription:
      'Earn 5% back in coins on eligible room bookings. Applies to your account only.',
  },
  {
    code: 'CORPORATE',
    name: 'Corporate',
    price: 2599,
    durationDays: 365,
    discountPercent: 10,
    benefitsDescription:
      'Earn 10% back in coins on eligible room bookings. Applies to your account only — company-wide employee benefits coming soon.',
  },
] as const;

async function main() {
  for (const plan of MEMBERSHIP_PLANS) {
    await prisma.membershipPlan.upsert({
      where: { code: plan.code },
      update: {
        name: plan.name,
        price: plan.price,
        durationDays: plan.durationDays,
        discountPercent: plan.discountPercent,
        benefitsDescription: plan.benefitsDescription,
        isActive: true,
      },
      create: plan,
    });
  }

  for (const role of PLATFORM_ROLES) {
    await prisma.role.upsert({
      where: { name: role.name },
      update: { description: role.description },
      create: role,
    });
  }

  for (const pt of PROPERTY_TYPES) {
    await prisma.propertyType.upsert({
      where: { code: pt.code },
      update: { name: pt.name, description: pt.description },
      create: pt,
    });
  }

  for (const amenity of AMENITIES) {
    await prisma.amenity.upsert({
      where: { name: amenity.name },
      update: { category: amenity.category },
      create: { ...amenity, status: 'ACTIVE' },
    });
  }

  for (const meal of MEAL_PLANS) {
    await prisma.mealPlan.upsert({
      where: { code: meal.code },
      update: { name: meal.name },
      create: meal,
    });
  }

  for (const tag of PROPERTY_TAGS) {
    await prisma.propertyTag.upsert({
      where: { code: tag.code },
      update: { name: tag.name },
      create: tag,
    });
  }

  for (const cityData of CITIES_WITH_AREAS) {
    const city = await prisma.city.upsert({
      where: { slug: cityData.slug },
      update: { name: cityData.name, state: cityData.state },
      create: {
        name: cityData.name,
        slug: cityData.slug,
        state: cityData.state,
        country: 'India',
      },
    });

    for (const areaName of cityData.areas) {
      const slug = areaName.toLowerCase().replace(/[^\w]+/g, '-');
      await prisma.area.upsert({
        where: { cityId_slug: { cityId: city.id, slug } },
        update: { name: areaName },
        create: { cityId: city.id, name: areaName, slug },
      });
    }
  }

  await prisma.cancellationPolicy.upsert({
    where: { name: 'Flexible' },
    update: { description: 'Free cancellation until 24 hours before check-in' },
    create: {
      name: 'Flexible',
      description: 'Free cancellation until 24 hours before check-in',
    },
  });

  await prisma.organization.upsert({
    where: { id: '00000000-0000-4000-8000-000000000001' },
    update: { name: 'AlterStays Ops' },
    create: {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'AlterStays Ops',
      type: 'HOTEL_OPERATOR',
      status: 'ACTIVE',
    },
  });

  const adminPhone = process.env.ADMIN_SEED_PHONE ?? '+919999999999';
  const adminPassword = process.env.ADMIN_SEED_PASSWORD ?? 'Admin@123';
  const superAdminRole = await prisma.role.findUniqueOrThrow({
    where: { name: 'SUPER_ADMIN' },
  });

  const passwordHash = await bcrypt.hash(adminPassword, 10);
  const adminUser = await prisma.user.upsert({
    where: { phone: adminPhone },
    update: {
      passwordHash,
      status: UserStatus.ACTIVE,
      firstName: 'Super',
      lastName: 'Admin',
    },
    create: {
      phone: adminPhone,
      passwordHash,
      status: UserStatus.ACTIVE,
      firstName: 'Super',
      lastName: 'Admin',
      mobileVerifiedAt: new Date(),
    },
  });

  await prisma.userRole.upsert({
    where: {
      userId_roleId: { userId: adminUser.id, roleId: superAdminRole.id },
    },
    update: {},
    create: { userId: adminUser.id, roleId: superAdminRole.id },
  });

  console.log(`Seeded SUPER_ADMIN: ${adminPhone} / ${adminPassword}`);

  const guwahati = await prisma.city.findUnique({ where: { slug: 'guwahati' } });
  if (guwahati) {
    const defaultArea = await prisma.area.findFirst({
      where: { cityId: guwahati.id },
      orderBy: { name: 'asc' },
    });
    const tagRecords = await prisma.propertyTag.findMany({
      where: { code: { in: ['COUPLE_FRIENDLY', 'ACCEPTS_LOCAL_ID'] } },
    });

    const guwahatiProperties = await prisma.property.findMany({
      where: {
        addresses: {
          some: { city: { equals: 'Guwahati', mode: 'insensitive' } },
        },
      },
    });

    for (const property of guwahatiProperties) {
      await prisma.property.update({
        where: { id: property.id },
        data: {
          areaId: defaultArea?.id,
          guestRating: property.guestRating ?? 4.6,
        },
      });

      for (const tag of tagRecords) {
        await prisma.propertyTagAssignment.upsert({
          where: {
            propertyId_tagId: { propertyId: property.id, tagId: tag.id },
          },
          update: {},
          create: { propertyId: property.id, tagId: tag.id },
        });
      }
    }
  }
}

main()
  .catch((error) => {
    console.error('Seed failed:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
