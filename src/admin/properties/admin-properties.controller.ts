import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Roles } from '../../common/decorators/roles.decorator';
import { RolesGuard } from '../../common/guards/roles.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import {
  CreatePropertyDto,
  UpdatePropertyAmenitiesDto,
  UpdatePropertyDto,
  UpdatePropertyPoliciesDto,
  UpdatePropertyStatusDto,
} from '../dto/admin.dto';
import { AdminPropertiesService } from './admin-properties.service';

@Controller('admin/properties')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('SUPER_ADMIN')
export class AdminPropertiesController {
  constructor(private readonly properties: AdminPropertiesService) {}

  @Get()
  list() {
    return this.properties.list();
  }

  @Post()
  create(@Body() dto: CreatePropertyDto) {
    return this.properties.create(dto);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.properties.getById(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdatePropertyDto) {
    return this.properties.update(id, dto);
  }

  @Patch(':id/status')
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdatePropertyStatusDto,
  ) {
    return this.properties.updateStatus(id, dto);
  }

  @Put(':id/amenities')
  replaceAmenities(
    @Param('id') id: string,
    @Body() dto: UpdatePropertyAmenitiesDto,
  ) {
    return this.properties.replaceAmenities(id, dto);
  }

  @Put(':id/policies')
  replacePolicies(
    @Param('id') id: string,
    @Body() dto: UpdatePropertyPoliciesDto,
  ) {
    return this.properties.replacePolicies(id, dto);
  }

  @Post(':id/images')
  @UseInterceptors(FileInterceptor('file'))
  uploadImage(
    @Param('id') id: string,
    @UploadedFile() file: Express.Multer.File,
  ) {
    if (!file) throw new BadRequestException('Image file is required');
    return this.properties.addImage(id, file);
  }

  @Delete(':id/images/:imageId')
  deleteImage(
    @Param('id') id: string,
    @Param('imageId') imageId: string,
  ) {
    return this.properties.deleteImage(id, imageId);
  }
}
