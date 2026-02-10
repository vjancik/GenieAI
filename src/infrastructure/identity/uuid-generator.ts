import { v4 as uuidv4 } from 'uuid';
import type { IIdentityGenerator } from '../../core/application/interfaces/identity-generator.interface';

export class UuidGenerator implements IIdentityGenerator {
	generate(): string {
		return uuidv4();
	}
}
