<?php
namespace Autonoma\Sdk\Types;
class ResolvedTree {
    /** @var CreateOp[] */
    public array $ops = [];
    /** @var DeferredUpdate[] */
    public array $deferredUpdates = [];
    /** @var array<string, string> */
    public array $aliases = [];
}
