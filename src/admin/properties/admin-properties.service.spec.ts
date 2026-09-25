import {
  BadRequestException,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { S3Service } from '../uploads/s3.service';
import { AdminPropertiesService } from './admin-properties.service';

const imageUrl =
  'https://media.alterstay.in/alterstay-images/properties/prop-1/abc.jpg';

describe('AdminPropertiesService.deleteImage', () => {
  const findFirst = jest.fn();
  const deleteRow = jest.fn();
  const extractObjectKey = jest.fn();
  const deleteObject = jest.fn();
  let service: AdminPropertiesService;
  let logError: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    logError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    findFirst.mockResolvedValue({ id: 'img-1', url: imageUrl });
    extractObjectKey.mockReturnValue('properties/prop-1/abc.jpg');
    service = new AdminPropertiesService(
      {
        propertyImage: { findFirst, delete: deleteRow },
      } as unknown as PrismaService,
      { extractObjectKey, deleteObject } as unknown as S3Service,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('removes the object and then the database row', async () => {
    deleteObject.mockResolvedValue(undefined);
    deleteRow.mockResolvedValue({});

    await expect(service.deleteImage('prop-1', 'img-1')).resolves.toEqual({
      success: true,
    });
    expect(deleteObject).toHaveBeenCalledWith('properties/prop-1/abc.jpg');
    expect(deleteRow).toHaveBeenCalledWith({ where: { id: 'img-1' } });
    expect(deleteObject.mock.invocationCallOrder[0]).toBeLessThan(
      deleteRow.mock.invocationCallOrder[0],
    );
  });

  it('keeps the database row and reports failure when storage delete fails', async () => {
    deleteObject.mockRejectedValue(new Error('connection refused'));

    await expect(service.deleteImage('prop-1', 'img-1')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(deleteRow).not.toHaveBeenCalled();
  });

  it('reports failure when the row delete fails after the object was removed', async () => {
    deleteObject.mockResolvedValue(undefined);
    deleteRow.mockRejectedValue(new Error('db down'));

    await expect(service.deleteImage('prop-1', 'img-1')).rejects.toBeInstanceOf(
      InternalServerErrorException,
    );
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('properties/prop-1/abc.jpg'),
      expect.any(String),
    );
  });

  it('rejects images that do not reference the configured bucket', async () => {
    extractObjectKey.mockReturnValue(null);

    await expect(service.deleteImage('prop-1', 'img-1')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(deleteObject).not.toHaveBeenCalled();
    expect(deleteRow).not.toHaveBeenCalled();
  });
});
