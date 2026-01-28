import { Module, Global } from '@nestjs/common';
import { StarterPromptService } from './starter-prompt.service.js';
import { CodingPromptService } from './coding-prompt.service.js';
import { ReviewerPromptService } from './reviewer-prompt.service.js';
import { DeployerPromptService } from './deployer-prompt.service.js';
import { VerifierPromptService } from './verifier-prompt.service.js';
import { AuditorPromptService } from './auditor-prompt.service.js';

@Global()
@Module({
  providers: [
    StarterPromptService,
    CodingPromptService,
    ReviewerPromptService,
    DeployerPromptService,
    VerifierPromptService,
    AuditorPromptService,
  ],
  exports: [
    StarterPromptService,
    CodingPromptService,
    ReviewerPromptService,
    DeployerPromptService,
    VerifierPromptService,
    AuditorPromptService,
  ],
})
export class PromptsModule {}
