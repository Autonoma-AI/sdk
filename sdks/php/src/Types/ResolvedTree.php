<?php

namespace Autonoma\Sdk\Types;

class ResolvedTree
{
    /** @var CreateOp[] */
    public array $ops = [];

    /** @var array<string, string> alias -> temp id */
    public array $aliases = [];

    /** @var array<string, string> alias -> model name */
    public array $aliasOwnerModel = [];

    /** @var array<string, string[]> alias -> list of dependency aliases */
    public array $aliasDependencies = [];
}
